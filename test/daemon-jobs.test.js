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
});

