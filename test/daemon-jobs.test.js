import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  maskSessionId,
  sanitizeLogMessage,
  buildSafeTempFilePath,
  validateDownloadUrl,
  selectTargetPrinter,
  processJob,
  startDaemon,
} from '../index.js';
import * as printer from '../printer.js';

function createFreshState() {
  return {
    pendingBwPages: 0,
    pendingColorPages: 0,
    processingJobs: new Set(),
    completedJobs: new Set(),
  };
}

function makeFakeFetch(payloadMap = {}) {
  return async (url) => {
    const entry = payloadMap[url] || payloadMap['*'];
    if (!entry) {
      return { ok: false, status: 404, statusText: 'Not Found' };
    }
    if (entry.throwErr) {
      throw entry.throwErr;
    }
    if (entry.ok === false) {
      return { ok: false, status: entry.status || 500, statusText: entry.statusText || 'Server Error' };
    }
    const buf = Buffer.isBuffer(entry.body)
      ? entry.body
      : Buffer.from(entry.body || '%PDF-1.4\n%%EOF\n', 'ascii');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  };
}

describe('Phase 5 — Filename, URL, Log Redaction & Printer Queue Safety', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-daemon-sec-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should neutralize POSIX and Windows path traversal, leading hyphens, and concurrent filename collisions', () => {
    const posixTraversal = buildSafeTempFilePath(
      tempDir,
      '../job_01',
      '../../file_01',
      '../../../../var/lib/printellect/config.json'
    );
    assert.ok(posixTraversal.filePath.startsWith(path.resolve(tempDir) + path.sep));
    assert.equal(path.dirname(posixTraversal.filePath), path.resolve(tempDir));
    assert.ok(posixTraversal.displayFileName.endsWith('.pdf'));
    assert.equal(posixTraversal.filePath.includes('..'), false);

    const winTraversal = buildSafeTempFilePath(
      tempDir,
      'job_02',
      'file_02',
      '..\\..\\..\\etc\\printellect\\kiosk.env'
    );
    assert.equal(path.dirname(winTraversal.filePath), path.resolve(tempDir));
    assert.ok(winTraversal.displayFileName.endsWith('.pdf'));

    const dashFlagName = buildSafeTempFilePath(
      tempDir,
      'job_03',
      'file_03',
      '--option-injection.pdf'
    );
    assert.equal(path.basename(dashFlagName.filePath).startsWith('-'), false);
    assert.equal(dashFlagName.displayFileName.startsWith('-'), false);

    // Two concurrent jobs uploading "resume.pdf" must never collide on disk
    const concurrentA = buildSafeTempFilePath(tempDir, 'job_A', 'f1', 'resume.pdf');
    const concurrentB = buildSafeTempFilePath(tempDir, 'job_B', 'f1', 'resume.pdf');
    const sameJobRetry = buildSafeTempFilePath(tempDir, 'job_A', 'f1', 'resume.pdf');
    assert.notEqual(concurrentA.filePath, concurrentB.filePath);
    assert.notEqual(concurrentA.filePath, sameJobRetry.filePath);
  });

  it('should enforce HTTPS download URLs (or local loopback HTTP) and reject file:// or ftp://', () => {
    assert.equal(
      validateDownloadUrl('https://firebasestorage.googleapis.com/v0/b/app/o/doc.pdf?alt=media&token=abc'),
      'https://firebasestorage.googleapis.com/v0/b/app/o/doc.pdf?alt=media&token=abc'
    );
    assert.equal(
      validateDownloadUrl('http://127.0.0.1:8123/test.pdf'),
      'http://127.0.0.1:8123/test.pdf'
    );
    assert.throws(() => validateDownloadUrl('file:///etc/printellect/kiosk.env'), /Unsupported or insecure/);
    assert.throws(() => validateDownloadUrl('http://evil.example.com/payload.pdf'), /Unsupported or insecure/);
    assert.throws(() => validateDownloadUrl('ftp://files.example.com/doc.pdf'), /Unsupported or insecure/);
    assert.throws(() => validateDownloadUrl(''), /Missing file download URL/);
  });

  it('should mask session IDs and redact storage tokens/credentials from log messages', () => {
    assert.equal(maskSessionId('ab'), '****');
    assert.equal(maskSessionId('station1'), 's****1');
    assert.equal(maskSessionId('prod_kiosk_session_99'), 'pro****99 (length: 21)');

    const errWithStorageToken = new Error(
      'Fetch failed for https://firebasestorage.googleapis.com/v0/b/x/o/a.pdf?alt=media&token=super-secret-uuid-999&apiKey=AIzaSecret'
    );
    const sanitized = sanitizeLogMessage(errWithStorageToken);
    assert.equal(sanitized.includes('super-secret-uuid-999'), false);
    assert.equal(sanitized.includes('AIzaSecret'), false);
    assert.match(sanitized, /token=\[REDACTED\]/);
    assert.match(sanitized, /apiKey=\[REDACTED\]/);
  });

  it('should reject missing printer queue (no silent default printer) and unsafe leading-dash queue names in printer.js', async () => {
    const samplePdf = path.join(tempDir, 'sample.pdf');
    fs.writeFileSync(samplePdf, '%PDF-1.4\n%%EOF\n');

    await assert.rejects(
      () => printer.print(samplePdf, { copies: 1, color: false }),
      /Explicit target printer queue \(options\.printer\) is required/
    );
    await assert.rejects(
      () => printer.print(samplePdf, { printer: '   ' }),
      /Explicit target printer queue \(options\.printer\) is required/
    );
    await assert.rejects(
      () => printer.print(samplePdf, { printer: '-oMaliciousOption' }),
      /Unsafe or invalid printer queue name rejected/
    );

    assert.equal(printer.isSafeQueueName('Canon_GX6100', { cupsStrict: true }), true);
    assert.equal(printer.isSafeQueueName('-dEvil', { cupsStrict: true }), false);
    assert.equal(printer.isSafeQueueName('Queue With Spaces', { cupsStrict: true }), false);
    assert.equal(printer.isSafeQueueName('Queue/Slash', { cupsStrict: true }), false);
  });
});

describe('Phase 5 — Firestore Job Lifecycle, Payment Gate, Shared Queue & Explicit Failure Outcomes', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-daemon-jobs-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should support shared single CUPS queue (Canon_GX6100) for both B&W and Color roles without self-fallback retry', async () => {
    const state = createFreshState();
    const sharedConfig = { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' };
    const printCalls = [];
    const firestoreUpdates = [];

    const res = await processJob(
      'job_shared_01',
      { status: 'on-queue', shopid: 'shop_1' },
      sharedConfig,
      {
        tempDir,
        state,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f_bw',
              data: () => ({
                'file-url': 'https://storage.example.com/bw.pdf',
                'file-name': 'bw_notes.pdf',
                color: false,
                copies: 1,
                fb: false,
                'total-pages': 2,
              }),
            },
            {
              id: 'f_color',
              data: () => ({
                'file-url': 'https://storage.example.com/color.pdf',
                'file-name': 'poster.pdf',
                color: true,
                copies: 2,
                fb: true,
                'total-pages': 1,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: {
          print: async (fp, opts) => {
            assert.equal(fs.existsSync(fp), true, 'Temp PDF must exist during print call');
            printCalls.push({ fp, opts });
          },
        },
        updateDoc: async (ref, data) => {
          firestoreUpdates.push({ ref, data });
        },
      }
    );

    assert.equal(res.outcome, 'completed');
    assert.equal(printCalls.length, 2);
    assert.deepEqual(printCalls[0].opts, {
      printer: 'Canon_GX6100',
      copies: 1,
      color: false,
      duplex: false,
    });
    assert.deepEqual(printCalls[1].opts, {
      printer: 'Canon_GX6100',
      copies: 2,
      color: true,
      duplex: true,
    });
    // Temp files cleaned up and load counters balanced back to 0
    assert.equal(fs.existsSync(printCalls[0].fp), false);
    assert.equal(fs.existsSync(printCalls[1].fp), false);
    assert.equal(state.pendingBwPages, 0);
    assert.equal(state.pendingColorPages, 0);
    assert.equal(firestoreUpdates.length, 1);
    assert.equal(firestoreUpdates[0].data.status, 'completed');
    assert.deepEqual(firestoreUpdates[0].data['collection-trays'], ['Tray 1']);

    // Now verify that if Canon_GX6100 errors on a B&W job in shared-queue mode, it does NOT double-submit to itself
    let sharedFailAttempts = 0;
    const failUpdates = [];
    const failRes = await processJob(
      'job_shared_fail',
      { status: 'on-queue', shopid: 'shop_1' },
      sharedConfig,
      {
        tempDir,
        state,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f1',
              data: () => ({
                'file-url': 'https://storage.example.com/bw.pdf',
                'file-name': 'bw.pdf',
                color: false,
                copies: 1,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: {
          print: async () => {
            sharedFailAttempts += 1;
            throw new Error('CUPS queue Canon_GX6100 offline');
          },
        },
        updateDoc: async (_ref, data) => failUpdates.push(data),
      }
    );
    assert.equal(sharedFailAttempts, 1, 'Shared queue must not retry against itself as fallback');
    assert.equal(failRes.outcome, 'failed');
    assert.equal(failUpdates[0].status, 'failed');
  });

  it('should NEVER silently print a Color job on B&W-only kiosk or mark unprinted/failed jobs as completed', async () => {
    const state = createFreshState();
    const bwOnlyConfig = { bwPrinter: 'HP_LaserJet_BW', colorPrinter: null };
    const printCalls = [];
    const updates = [];

    // 1. Color job arrives on B&W-only kiosk -> zero print calls, status marked 'failed' (never 'completed')
    const colorOnBwRes = await processJob(
      'job_unconfigured_color',
      { status: 'on-queue', shopid: 'shop_1' },
      bwOnlyConfig,
      {
        tempDir,
        state,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f_col',
              data: () => ({
                'file-url': 'https://storage.example.com/color.pdf',
                'file-name': 'color_brochure.pdf',
                color: true,
                copies: 1,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: { print: async (_fp, opts) => printCalls.push(opts) },
        updateDoc: async (_ref, data) => updates.push(data),
      }
    );

    assert.equal(colorOnBwRes.outcome, 'failed');
    assert.equal(printCalls.length, 0, 'Must never route color job to B&W printer or default printer');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'failed');
    assert.match(updates[0]['failure-reason'], /Color printer not configured/);

    // 2. Download failure with secret Firebase Storage token in error -> marks 'failed', redacts token, cleans counters
    const dlUpdates = [];
    const dlFailRes = await processJob(
      'job_download_fail',
      { status: 'on-queue', shopid: 'shop_1' },
      bwOnlyConfig,
      {
        tempDir,
        state,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f_dl',
              data: () => ({
                'file-url': 'https://storage.example.com/missing.pdf?alt=media&token=secret_dl_tok_777',
                'file-name': 'lecture.pdf',
                color: false,
                copies: 3,
                'total-pages': 5,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({
          '*': {
            throwErr: new Error(
              'Network error fetching https://storage.example.com/missing.pdf?alt=media&token=secret_dl_tok_777'
            ),
          },
        }),
        printer: { print: async (_fp, opts) => printCalls.push(opts) },
        updateDoc: async (_ref, data) => dlUpdates.push(data),
      }
    );

    assert.equal(dlFailRes.outcome, 'failed');
    assert.equal(dlUpdates[0].status, 'failed');
    assert.equal(dlUpdates[0]['failure-reason'].includes('secret_dl_tok_777'), false);
    assert.match(dlUpdates[0]['failure-reason'], /token=\[REDACTED\]/);
    assert.equal(state.pendingBwPages, 0);
    assert.equal(state.pendingColorPages, 0);
  });

  it('should enforce payment gate, session/outlet isolation, duplicate onSnapshot deduplication, and clean SIGTERM unsubscribe', async () => {
    const state = createFreshState();
    let snapshotCallback = null;
    let unsubscribedCount = 0;
    let exitCodes = [];
    const printedJobFiles = [];
    const firestoreUpdates = [];

    const daemon = await startDaemon({
      argv: [],
      env: { KIOSK_SESSION_ID: 'kiosk_target_01' },
      registerSignals: false,
      state,
      exit: (code) => exitCodes.push(code),
      loadConfig: () => ({
        config: { bwPrinter: 'HP_BW', colorPrinter: 'Canon_Color' },
        configPath: '/var/lib/printellect/config.json',
        isLegacy: false,
      }),
      auth: {},
      db: {},
      signInAnonymously: async () => ({ user: { uid: 'u1' } }),
      collection: (_db, p) => ({ path: p }),
      query: (...args) => ({ args }),
      where: (...args) => ({ args }),
      doc: (_db, col, id) => ({ col, id }),
      onSnapshot: (_q, onNext) => {
        snapshotCallback = onNext;
        return () => {
          unsubscribedCount += 1;
        };
      },
      getDocs: async (ref) => ({
        empty: false,
        docs: [
          {
            id: 'f1',
            data: () => ({
              'file-url': `https://storage.example.com/${ref.path}.pdf`,
              'file-name': 'doc.pdf',
              color: false,
              copies: 1,
            }),
          },
        ],
      }),
      fetch: makeFakeFetch({ '*': { ok: true } }),
      printer: {
        print: async (_fp, opts) => {
          printedJobFiles.push(opts);
        },
      },
      updateDoc: async (ref, data) => {
        firestoreUpdates.push({ id: ref.id, ...data });
      },
    });

    assert.ok(snapshotCallback, 'onSnapshot listener must be attached');

    // Emit batch containing: unpaid job, missing-shopid job, wrong-session job, non-kiosk job, removed event, and 2 duplicate events for paid job_paid_01
    snapshotCallback({
      docChanges: () => [
        {
          type: 'added',
          doc: {
            id: 'job_unpaid',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': true, status: 'pending', shopid: 'shop_1' }),
          },
        },
        {
          type: 'added',
          doc: {
            id: 'job_no_outlet',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': true, status: 'on-queue', shopid: '' }),
          },
        },
        {
          type: 'added',
          doc: {
            id: 'job_other_kiosk',
            data: () => ({ 'kiosk-session-id': 'kiosk_OTHER_99', 'is-kiosk-job': true, status: 'on-queue', shopid: 'shop_1' }),
          },
        },
        {
          type: 'added',
          doc: {
            id: 'job_non_kiosk',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': false, status: 'on-queue', shopid: 'shop_1' }),
          },
        },
        {
          type: 'removed',
          doc: {
            id: 'job_removed',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': true, status: 'on-queue', shopid: 'shop_1' }),
          },
        },
        {
          type: 'added',
          doc: {
            id: 'job_paid_01',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': true, status: 'on-queue', shopid: 'shop_1' }),
          },
        },
        {
          type: 'modified',
          doc: {
            id: 'job_paid_01',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': true, status: 'on-queue', shopid: 'shop_1' }),
          },
        },
      ],
    });

    // Wait briefly for async processJob completion
    await new Promise((r) => setTimeout(r, 80));

    // Simulate Firestore listener reconnect re-delivering job_paid_01 before server sees 'completed'
    snapshotCallback({
      docChanges: () => [
        {
          type: 'added',
          doc: {
            id: 'job_paid_01',
            data: () => ({ 'kiosk-session-id': 'kiosk_target_01', 'is-kiosk-job': true, status: 'on-queue', shopid: 'shop_1' }),
          },
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(printedJobFiles.length, 1, 'Only paid job_paid_01 must print, and strictly once');
    assert.equal(firestoreUpdates.length, 1);
    assert.equal(firestoreUpdates[0].id, 'job_paid_01');
    assert.equal(firestoreUpdates[0].status, 'completed');

    // Clean shutdown unsubscribes listener idempotently
    daemon.shutdown('SIGTERM');
    daemon.shutdown('SIGINT');
    assert.equal(unsubscribedCount, 1);
    assert.deepEqual(exitCodes, [0]);
  });

  it('should load-balance distinct dual queues accurately via selectTargetPrinter', () => {
    const dualCfg = { bwPrinter: 'HP_BW', colorPrinter: 'Canon_Color' };
    const st = { pendingBwPages: 0, pendingColorPages: 0 };

    const first = selectTargetPrinter({ isColor: false, config: dualCfg, state: st });
    assert.equal(first.targetPrinter, 'HP_BW');

    st.pendingBwPages = 10;
    st.pendingColorPages = 2;
    const second = selectTargetPrinter({ isColor: false, config: dualCfg, state: st });
    assert.equal(second.targetPrinter, 'Canon_Color');
  });

  it('should mark empty file lists, all-disabled printer configs, dual-queue CUPS failures, and partial multi-file failures as failed without unlocking collection trays', async () => {
    const state = createFreshState();

    // 1. Empty files subcollection -> status: 'failed', zero print calls, zero collection-trays
    const emptyUpdates = [];
    let emptyPrints = 0;
    const emptyRes = await processJob(
      'job_empty_files',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' },
      {
        tempDir,
        state,
        statusRetryDelayMs: 0,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({ empty: true, docs: [] }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: { print: async () => { emptyPrints += 1; } },
        updateDoc: async (_ref, data) => emptyUpdates.push(data),
      }
    );
    assert.equal(emptyRes.outcome, 'failed');
    assert.equal(emptyRes.reason, 'empty_files');
    assert.equal(emptyPrints, 0);
    assert.equal(emptyUpdates.length, 1);
    assert.equal(emptyUpdates[0].status, 'failed');
    assert.equal('collection-trays' in emptyUpdates[0], false, 'Failed empty job must never write collection-trays');

    // 2. Both printer roles unavailable (bwPrinter: null, colorPrinter: null) -> status: 'failed'
    const noPrinterUpdates = [];
    const noPrinterRes = await processJob(
      'job_no_printers_configured',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      { bwPrinter: null, colorPrinter: null },
      {
        tempDir,
        state,
        statusRetryDelayMs: 0,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f1',
              data: () => ({
                'file-url': 'https://storage.example.com/bw.pdf',
                'file-name': 'bw.pdf',
                color: false,
                copies: 1,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: { print: async () => { throw new Error('Should not print'); } },
        updateDoc: async (_ref, data) => noPrinterUpdates.push(data),
      }
    );
    assert.equal(noPrinterRes.outcome, 'failed');
    assert.equal(noPrinterUpdates[0].status, 'failed');
    assert.match(noPrinterUpdates[0]['failure-reason'], /No B&W or Color printer configured/);
    assert.equal('collection-trays' in noPrinterUpdates[0], false);

    // 3. Dual-queue CUPS fallback: B&W fails on HP_BW -> succeeds once on Canon_Color (Tray 2)
    const dualConfig = { bwPrinter: 'HP_BW', colorPrinter: 'Canon_Color' };
    const fbUpdates = [];
    const fbPrintCalls = [];
    const fbRes = await processJob(
      'job_bw_fallback_ok',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      dualConfig,
      {
        tempDir,
        state,
        statusRetryDelayMs: 0,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f_bw',
              data: () => ({
                'file-url': 'https://storage.example.com/notes.pdf',
                'file-name': 'notes.pdf',
                color: false,
                copies: 1,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: {
          print: async (_fp, opts) => {
            fbPrintCalls.push(opts);
            if (opts.printer === 'HP_BW') {
              throw new Error('lp: HP_BW paper jam');
            }
          },
        },
        updateDoc: async (_ref, data) => fbUpdates.push(data),
      }
    );
    assert.equal(fbRes.outcome, 'completed');
    assert.equal(fbPrintCalls.length, 2);
    assert.equal(fbPrintCalls[1].printer, 'Canon_Color');
    assert.equal(fbPrintCalls[1].color, false, 'B&W fallback on color printer must enforce grayscale');
    assert.deepEqual(fbUpdates[0]['collection-trays'], ['Tray 2']);

    // 4. Dual-queue CUPS error on BOTH primary and fallback -> status: 'failed', zero completed/door unlock
    const bothFailUpdates = [];
    const bothFailRes = await processJob(
      'job_dual_both_fail',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      dualConfig,
      {
        tempDir,
        state,
        statusRetryDelayMs: 0,
        db: {},
        doc: (_db, col, id) => ({ col, id }),
        collection: (_db, p) => ({ path: p }),
        getDocs: async () => ({
          empty: false,
          docs: [
            {
              id: 'f_bw2',
              data: () => ({
                'file-url': 'https://storage.example.com/notes2.pdf',
                'file-name': 'notes2.pdf',
                color: false,
                copies: 1,
              }),
            },
          ],
        }),
        fetch: makeFakeFetch({ '*': { ok: true } }),
        printer: {
          print: async (_fp, opts) => {
            throw new Error(`lp: ${opts.printer} offline`);
          },
        },
        updateDoc: async (_ref, data) => bothFailUpdates.push(data),
      }
    );
    assert.equal(bothFailRes.outcome, 'failed');
    assert.equal(bothFailUpdates.length, 1);
    assert.equal(bothFailUpdates[0].status, 'failed');
    assert.equal('collection-trays' in bothFailUpdates[0], false);

    // 5. Partial multi-file failure (file 1 prints, file 2 fails CUPS) -> status: 'failed', NEVER 'completed',
    //    and duplicate/stale 'on-queue' retry CANNOT re-print file 1!
    const partialUpdates = [];
    const partialPrintedFiles = [];
    const partialDeps = {
      tempDir,
      state,
      statusRetryDelayMs: 0,
      db: {},
      doc: (_db, col, id) => ({ col, id }),
      collection: (_db, p) => ({ path: p }),
      getDocs: async () => ({
        empty: false,
        docs: [
          {
            id: 'f_part_1',
            data: () => ({
              'file-url': 'https://storage.example.com/part1.pdf',
              'file-name': 'part1.pdf',
              color: false,
              copies: 1,
            }),
          },
          {
            id: 'f_part_2',
            data: () => ({
              'file-url': 'https://storage.example.com/part2.pdf',
              'file-name': 'part2.pdf',
              color: true,
              copies: 1,
            }),
          },
        ],
      }),
      fetch: makeFakeFetch({ '*': { ok: true } }),
      printer: {
        print: async (fp, opts) => {
          if (opts.color === true) {
            throw new Error('lp: out of cyan ink');
          }
          partialPrintedFiles.push(path.basename(fp));
        },
      },
      updateDoc: async (_ref, data) => partialUpdates.push(data),
    };

    const partialRes = await processJob(
      'job_partial_failure',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' },
      partialDeps
    );
    assert.equal(partialRes.outcome, 'failed');
    assert.equal(partialRes.printedFiles, 1);
    assert.equal(partialRes.totalFiles, 2);
    assert.equal(partialPrintedFiles.length, 1);
    assert.equal(partialUpdates.length, 1);
    assert.equal(partialUpdates[0].status, 'failed');
    assert.equal(partialUpdates[0]['printed-files'], 1);
    assert.equal(partialUpdates[0]['total-files'], 2);
    assert.equal('collection-trays' in partialUpdates[0], false, 'Partially printed job must never unlock tray');

    // Duplicate/stale invocation for same failed job ID must NOT re-print file 1
    const duplicatePartialRes = await processJob(
      'job_partial_failure',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' },
      partialDeps
    );
    assert.equal(duplicatePartialRes.outcome, 'duplicate_ignored');
    assert.equal(partialPrintedFiles.length, 1, 'File 1 must NOT be printed a second time');
  });

  it('should retry transient Firestore status writes without duplicate printing or duplicate delivery transitions', async () => {
    const state = createFreshState();
    let printCount = 0;
    let updateAttempts = 0;
    const committedUpdates = [];

    const deps = {
      tempDir,
      state,
      statusRetryDelayMs: 0,
      db: {},
      doc: (_db, col, id) => ({ col, id }),
      collection: (_db, p) => ({ path: p }),
      getDocs: async () => ({
        empty: false,
        docs: [
          {
            id: 'f1',
            data: () => ({
              'file-url': 'https://storage.example.com/receipt.pdf',
              'file-name': 'receipt.pdf',
              color: false,
              copies: 1,
            }),
          },
        ],
      }),
      fetch: makeFakeFetch({ '*': { ok: true } }),
      printer: {
        print: async () => {
          printCount += 1;
        },
      },
      updateDoc: async (_ref, data) => {
        updateAttempts += 1;
        if (updateAttempts === 1) {
          throw new Error('UNAVAILABLE: transient Firestore transport error');
        }
        committedUpdates.push(data);
      },
    };

    const res = await processJob(
      'job_transient_status_write',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' },
      deps
    );
    assert.equal(res.outcome, 'completed');
    assert.equal(printCount, 1, 'Status write retry must NEVER re-print the document');
    assert.equal(updateAttempts, 2);
    assert.equal(committedUpdates.length, 1);
    assert.equal(committedUpdates[0].status, 'completed');

    // Even if external door hardware subsequently sets status='delivered' and a stale cached 'on-queue' snapshot arrives,
    // completedJobs prevents re-printing or re-writing status='completed' (no duplicate door-unlock transition).
    const staleReplay = await processJob(
      'job_transient_status_write',
      { status: 'on-queue', shopid: 'shop_1', 'is-kiosk-job': true },
      { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' },
      deps
    );
    assert.equal(staleReplay.outcome, 'duplicate_ignored');
    assert.equal(printCount, 1);
    assert.equal(committedUpdates.length, 1);
  });
});

