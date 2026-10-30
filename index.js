import { db as defaultDb, auth as defaultAuth } from './firebase.js';
import { signInAnonymously as defaultSignInAnonymously } from 'firebase/auth';
import {
  collection as defaultCollection,
  query as defaultQuery,
  where as defaultWhere,
  onSnapshot as defaultOnSnapshot,
  getDocs as defaultGetDocs,
  doc as defaultDoc,
  updateDoc as defaultUpdateDoc,
} from 'firebase/firestore';
import * as defaultPrinter from './printer.js';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { loadConfig as defaultLoadConfig } from './config.js';

const MAX_COMPLETED_JOBS_CACHE = 1000;
const DOWNLOAD_TIMEOUT_MS = 60000;

export const DEFAULT_PRODUCTION_JOBS_DIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'printellect', 'jobs')
  : '/var/lib/printellect/jobs';

export function resolveLedgerDir(customDir = null) {
  if (customDir) return path.resolve(customDir);
  if (process.env.PRINTELLECT_JOBS_DIR) return path.resolve(process.env.PRINTELLECT_JOBS_DIR);
  return DEFAULT_PRODUCTION_JOBS_DIR;
}

function getSafeJobFilename(jobId) {
  return String(jobId || 'job').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'job';
}

export function acquireJobClaim(ledgerDir, jobId, { pid = process.pid, maxStaleMs = 300000 } = {}) {
  if (!fs.existsSync(ledgerDir)) {
    try { fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o750 }); } catch (_) {}
  }
  const safeName = getSafeJobFilename(jobId);
  const lockPath = path.join(ledgerDir, `${safeName}.lock`);
  let fd = null;
  try {
    fd = fs.openSync(lockPath, 'wx');
    const claimData = JSON.stringify({ pid, createdAt: Date.now(), jobId }) + '\n';
    fs.writeSync(fd, claimData, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    return {
      acquired: true,
      lockPath,
      release: () => {
        try {
          if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
        } catch (_) {}
      },
    };
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (err.code === 'EEXIST') {
      try {
        const raw = fs.readFileSync(lockPath, 'utf8');
        const lockObj = JSON.parse(raw);
        const age = Date.now() - (lockObj.createdAt || 0);
        let isStale = age > maxStaleMs;
        if (!isStale && lockObj.pid) {
          try {
            process.kill(lockObj.pid, 0);
          } catch (e) {
            if (e.code === 'ESRCH') isStale = true;
          }
        }
        if (isStale) {
          try { fs.unlinkSync(lockPath); } catch (_) {}
          return acquireJobClaim(ledgerDir, jobId, { pid, maxStaleMs });
        }
        return {
          acquired: false,
          reason: 'locked_by_concurrent_instance',
          lockPid: lockObj.pid,
        };
      } catch (_) {
        return { acquired: false, reason: 'locked_by_concurrent_instance' };
      }
    }
    throw err;
  }
}

export function getJobRecord(ledgerDir, jobId) {
  const safeName = getSafeJobFilename(jobId);
  const filePath = path.join(ledgerDir, `${safeName}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

export function writeJobRecord(ledgerDir, jobId, record) {
  if (!fs.existsSync(ledgerDir)) {
    try { fs.mkdirSync(ledgerDir, { recursive: true, mode: 0o750 }); } catch (_) {}
  }
  const safeName = getSafeJobFilename(jobId);
  const targetPath = path.join(ledgerDir, `${safeName}.json`);
  const tempPath = path.join(ledgerDir, `.${safeName}.tmp.${process.pid}.${Date.now()}`);
  const payload = JSON.stringify({ jobId, updatedAt: new Date().toISOString(), ...record }, null, 2) + '\n';
  const fd = fs.openSync(tempPath, 'w', 0o640);
  fs.writeSync(fd, payload, 0, 'utf8');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tempPath, targetPath);
  return targetPath;
}

export function acquireDaemonLock(runDir = null) {
  const dir = runDir || process.env.PRINTELLECT_RUN_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'printellect')
    : (fs.existsSync('/run') ? '/run' : '/var/lib/printellect'));
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o755 }); } catch (_) {}
  }
  const lockFile = path.join(dir, 'printellect.lock');
  let fd = null;
  try {
    fd = fs.openSync(lockFile, 'wx');
    const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n';
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return {
      acquired: true,
      lockFile,
      release: () => {
        try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch (_) {}
      },
    };
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (err.code === 'EEXIST') {
      try {
        const raw = fs.readFileSync(lockFile, 'utf8');
        const lockObj = JSON.parse(raw);
        let isStale = false;
        if (lockObj.pid) {
          try {
            process.kill(lockObj.pid, 0);
          } catch (e) {
            if (e.code === 'ESRCH') isStale = true;
          }
        }
        if (Date.now() - (lockObj.startedAt || 0) > 300000) {
          isStale = true;
        }
        if (isStale) {
          try { fs.unlinkSync(lockFile); } catch (_) {}
          return acquireDaemonLock(runDir);
        }
        throw new Error(`Another PRINTELLECT daemon instance is already active (PID ${lockObj.pid}).`);
      } catch (readErr) {
        if (readErr.message && readErr.message.includes('Another PRINTELLECT daemon')) throw readErr;
        try { fs.unlinkSync(lockFile); } catch (_) {}
        return acquireDaemonLock(runDir);
      }
    }
    throw err;
  }
}

// Global load trackers and duplicate-execution guards
const defaultState = {
  pendingBwPages: 0,
  pendingColorPages: 0,
  processingJobs: new Set(),
  completedJobs: new Set(),
  failedJobs: new Set(),
};

/**
 * Masks sensitive session tokens so credentials are never printed in cleartext logs.
 * @param {string} token
 * @returns {string}
 */
export function maskSessionId(token) {
  const str = String(token || '');
  if (str.length <= 4) return '****';
  if (str.length <= 8) return `${str.slice(0, 1)}****${str.slice(-1)}`;
  return `${str.slice(0, 3)}****${str.slice(-2)} (length: ${str.length})`;
}

/**
 * Redacts URL query tokens (e.g. Firebase Storage ?token=...) and bearer/session credentials
 * from error messages before logging or persisting failure summaries.
 * @param {any} input
 * @returns {string}
 */
export function sanitizeLogMessage(input) {
  const raw = input instanceof Error ? input.message : String(input ?? '');
  return raw
    .replace(/([?&](?:token|key|apiKey|signature|sig|access_token)=)[^&\s"')]+/gi, '$1[REDACTED]')
    .replace(/(KIOSK_SESSION_ID\s*=\s*["']?)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]');
}

/**
 * Constructs a unique, path-traversal-proof temporary file path strictly inside tempDir.
 * Handles both POSIX ('/') and Windows ('\\') path separators in untrusted remote filenames,
 * strips leading dots/hyphens, and prevents concurrent jobs with identical filenames from colliding.
 *
 * @param {string} tempDir
 * @param {string} jobId
 * @param {string} fileId
 * @param {string} [rawFileName]
 * @returns {{ filePath: string, displayFileName: string }}
 */
export function buildSafeTempFilePath(tempDir, jobId, fileId, rawFileName) {
  const resolvedTempDir = path.resolve(tempDir);

  const safeJob = String(jobId || 'job')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^[-.]+/, '')
    .slice(0, 48) || 'job';
  const safeFile = String(fileId || 'file')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^[-.]+/, '')
    .slice(0, 48) || 'file';

  const rawStr = typeof rawFileName === 'string' && rawFileName.trim().length > 0
    ? rawFileName.trim()
    : `job_${safeJob}_${safeFile}.pdf`;

  // Split on both '/' and '\' regardless of host OS so cross-platform traversal strings are stripped
  const parts = rawStr.split(/[/\\]+/).filter(Boolean);
  let base = parts.length > 0 ? parts[parts.length - 1] : `job_${safeJob}_${safeFile}.pdf`;
  base = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^[-.]+/, '')
    .slice(0, 80);

  if (!base || base === '.' || base === '..') {
    base = 'document.pdf';
  }
  if (!base.toLowerCase().endsWith('.pdf')) {
    base = `${base}.pdf`;
  }

  const nonce = crypto.randomBytes(4).toString('hex');
  const uniqueName = `printellect_${safeJob}_${safeFile}_${nonce}_${base}`;
  const candidatePath = path.resolve(resolvedTempDir, uniqueName);

  const prefixWithSep = resolvedTempDir.endsWith(path.sep)
    ? resolvedTempDir
    : `${resolvedTempDir}${path.sep}`;
  if (!candidatePath.startsWith(prefixWithSep)) {
    throw new Error('Unsafe temporary file path rejected outside temporary directory.');
  }

  return {
    filePath: candidatePath,
    displayFileName: base,
  };
}

/**
 * Validates that a download URL uses HTTPS (or localhost/127.0.0.1 HTTP for isolated local integration tests).
 * Blocks file://, ftp://, and arbitrary non-HTTP schemes.
 * @param {string} rawUrl
 * @returns {string}
 */
export function validateDownloadUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Missing file download URL.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    throw new Error('Malformed file download URL.');
  }
  if (parsed.protocol === 'https:') {
    return parsed.toString();
  }
  if (
    parsed.protocol === 'http:' &&
    (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1')
  ) {
    return parsed.toString();
  }
  throw new Error(`Unsupported or insecure download URL protocol: ${parsed.protocol}`);
}

export async function downloadFile(url, destination, fetchImpl = fetch) {
  const safeUrl = validateDownloadUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImpl(safeUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText || 'download error'}`.trim());
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(destination, buffer, { mode: 0o600 });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Selects the target printer queue for a single file without ever falling back to an
 * unconfigured or arbitrary system default printer.
 *
 * @param {object} params
 * @param {boolean} params.isColor
 * @param {{ bwPrinter: string|null, colorPrinter: string|null }} params.config
 * @param {{ pendingBwPages: number, pendingColorPages: number }} params.state
 * @returns {{ targetPrinter: string|null, loadBucket: 'bw'|'color'|null, reason?: string }}
 */
export function selectTargetPrinter({ isColor, config, state }) {
  if (isColor) {
    if (!config.colorPrinter) {
      return {
        targetPrinter: null,
        loadBucket: null,
        reason: 'Color printer not configured on this kiosk',
      };
    }
    return {
      targetPrinter: config.colorPrinter,
      loadBucket: 'color',
    };
  }

  // B&W jobs prefer bwPrinter (Tray 1), load-balance across distinct dual queues,
  // and cleanly support shared single-queue MFPs (bwPrinter === colorPrinter) or color-only MFPs.
  if (config.bwPrinter && config.colorPrinter) {
    if (config.bwPrinter !== config.colorPrinter && state.pendingBwPages > state.pendingColorPages) {
      return {
        targetPrinter: config.colorPrinter,
        loadBucket: 'color',
      };
    }
    return {
      targetPrinter: config.bwPrinter,
      loadBucket: 'bw',
    };
  }
  if (config.bwPrinter) {
    return {
      targetPrinter: config.bwPrinter,
      loadBucket: 'bw',
    };
  }
  if (config.colorPrinter) {
    return {
      targetPrinter: config.colorPrinter,
      loadBucket: 'color',
    };
  }

  return {
    targetPrinter: null,
    loadBucket: null,
    reason: 'No B&W or Color printer configured on this kiosk',
  };
}

function recordTrackedJob(trackedSet, jobId) {
  if (trackedSet.size >= MAX_COMPLETED_JOBS_CACHE) {
    const oldest = trackedSet.values().next().value;
    if (oldest !== undefined) {
      trackedSet.delete(oldest);
    }
  }
  trackedSet.add(jobId);
}

/**
 * Retries only the terminal Firestore status update (never re-downloading or re-printing files)
 * so transient network blips cannot cause duplicate prints or duplicate delivery transitions.
 */
async function updateTaskStatusWithRetry(
  updateDocFn,
  taskDocRef,
  payload,
  { maxAttempts = 3, retryDelayMs = 200 } = {}
) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await updateDocFn(taskDocRef, payload);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastErr;
}

/**
 * Processes a payment-confirmed kiosk print job with explicit completion or failure outcomes.
 * Never marks a job 'completed' (which unlocks the kiosk door tray) unless every file in the job printed.
 */
export async function processJob(jobId, jobData, config, deps = {}) {
  const firestoreDb = deps.db || defaultDb;
  const collectionFn = deps.collection || defaultCollection;
  const getDocsFn = deps.getDocs || defaultGetDocs;
  const docFn = deps.doc || defaultDoc;
  const updateDocFn = deps.updateDoc || defaultUpdateDoc;
  const printerMod = deps.printer || defaultPrinter;
  const fetchImpl = deps.fetch || fetch;
  const tempDir = deps.tempDir || os.tmpdir();
  const state = deps.state || defaultState;
  const failedJobs = state.failedJobs || (state.failedJobs = new Set());
  const ledgerDir = resolveLedgerDir(deps.ledgerDir || (deps.tempDir ? path.join(deps.tempDir, 'jobs') : null));
  const statusRetryOpts = {
    maxAttempts: deps.statusMaxAttempts ?? 3,
    retryDelayMs: deps.statusRetryDelayMs ?? 200,
  };

  // 1. In-memory duplicate check
  if (state.completedJobs.has(jobId) || failedJobs.has(jobId)) {
    state.processingJobs.delete(jobId);
    return { outcome: 'duplicate_ignored', printedFiles: 0, totalFiles: 0 };
  }

  // 2. Defensive Firestore status check (rejects already-terminal documents)
  if (jobData && (jobData.status === 'completed' || jobData.status === 'delivered')) {
    recordTrackedJob(state.completedJobs, jobId);
    state.processingJobs.delete(jobId);
    return { outcome: 'duplicate_ignored', printedFiles: 0, totalFiles: 0 };
  }
  if (jobData && jobData.status === 'failed') {
    recordTrackedJob(failedJobs, jobId);
    state.processingJobs.delete(jobId);
    return { outcome: 'duplicate_ignored', printedFiles: 0, totalFiles: 0 };
  }

  // 3. Durable Ledger Check (survives daemon process restarts and crashes)
  const existingRecord = getJobRecord(ledgerDir, jobId);
  if (existingRecord) {
    if (existingRecord.status === 'completed') {
      recordTrackedJob(state.completedJobs, jobId);
      state.processingJobs.delete(jobId);
      return { outcome: 'duplicate_ignored', printedFiles: 0, totalFiles: 0 };
    }
    if (existingRecord.status === 'failed' || existingRecord.status === 'ambiguous_crash') {
      recordTrackedJob(failedJobs, jobId);
      state.processingJobs.delete(jobId);
      return { outcome: 'duplicate_ignored', printedFiles: 0, totalFiles: 0 };
    }
    if (existingRecord.status === 'printed') {
      // Succeeded in CUPS before crash/disconnect -> complete Firestore update without re-printing
      console.log(`[DURABLE RECOVERY] Job ${jobId} was previously spooled to CUPS. Completing Firestore status without re-printing...`);
      const taskDocRef = docFn(firestoreDb, 'tasks', jobId);
      const collectionTrays = existingRecord.collectionTrays || ['Tray 1'];
      await updateTaskStatusWithRetry(
        updateDocFn,
        taskDocRef,
        {
          status: 'completed',
          'completed-time': new Date(),
          'collection-trays': collectionTrays,
        },
        statusRetryOpts
      );
      writeJobRecord(ledgerDir, jobId, { ...existingRecord, status: 'completed' });
      recordTrackedJob(state.completedJobs, jobId);
      state.processingJobs.delete(jobId);
      return {
        outcome: 'recovered_completed',
        printedFiles: existingRecord.printedFiles ? existingRecord.printedFiles.length : 1,
        totalFiles: existingRecord.totalFiles || 1,
        collectionTrays,
      };
    }
    if (
      existingRecord.status === 'claimed' ||
      existingRecord.status === 'downloading' ||
      existingRecord.status === 'printing'
    ) {
      // Process died during active print execution: outcome is ambiguous.
      // Do not blindly retry CUPS; fail closed and record for technician review.
      const crashReason = `Ambiguous print outcome: daemon process terminated during ${existingRecord.status}. Physical inspection required before retry.`;
      console.error(`[CRASH RECOVERY FAIL-CLOSED] Job ${jobId}: ${crashReason}`);
      writeJobRecord(ledgerDir, jobId, { ...existingRecord, status: 'ambiguous_crash', error: crashReason });
      recordTrackedJob(failedJobs, jobId);
      const taskDocRef = docFn(firestoreDb, 'tasks', jobId);
      await updateTaskStatusWithRetry(
        updateDocFn,
        taskDocRef,
        {
          status: 'failed',
          'failed-time': new Date(),
          'failure-reason': crashReason,
        },
        statusRetryOpts
      );
      state.processingJobs.delete(jobId);
      return {
        outcome: 'failed',
        reason: 'ambiguous_crash',
        printedFiles: existingRecord.printedFiles ? existingRecord.printedFiles.length : 0,
        totalFiles: existingRecord.totalFiles || 0,
      };
    }
  }

  // 4. Concurrency Guard: Atomic lock claim for this specific job
  const claim = acquireJobClaim(ledgerDir, jobId);
  if (!claim.acquired) {
    console.warn(`[CONCURRENT GUARD] Job ${jobId} is currently being processed by another worker/instance (pid: ${claim.lockPid || 'active'}).`);
    state.processingJobs.delete(jobId);
    return { outcome: 'concurrent_claim_rejected', reason: 'locked' };
  }

  writeJobRecord(ledgerDir, jobId, { jobId, status: 'claimed', claimedAt: new Date().toISOString() });
  const succeededFilesList = [];

  try {
    const taskDocRef = docFn(firestoreDb, 'tasks', jobId);
    const filesRef = collectionFn(firestoreDb, `tasks/${jobId}/files`);
    const filesSnap = await getDocsFn(filesRef);

    if (filesSnap.empty || !filesSnap.docs || filesSnap.docs.length === 0) {
      console.error(`[ERROR] No printable files found in tasks/${jobId}/files. Marking job failed.`);
      writeJobRecord(ledgerDir, jobId, {
        jobId,
        status: 'failed',
        error: 'No printable files found in task subcollection',
        printedFiles: [],
        totalFiles: 0,
      });
      recordTrackedJob(failedJobs, jobId);
      await updateTaskStatusWithRetry(
        updateDocFn,
        taskDocRef,
        {
          status: 'failed',
          'failed-time': new Date(),
          'failure-reason': 'No printable files found in task subcollection',
        },
        statusRetryOpts
      );
      state.processingJobs.delete(jobId);
      return { outcome: 'failed', reason: 'empty_files', printedFiles: 0, totalFiles: 0 };
    }

    let printedOnBw = false;
    let printedOnColor = false;
    let hasColorFile = false;
    let hasBwFile = false;
    let succeededFiles = 0;
    const fileFailures = [];

    for (const fileDoc of filesSnap.docs) {
      const fileData = fileDoc.data() || {};
      const downloadUrl = fileData['file-url'] || fileData.downloadUrl;
      const rawFileName = fileData['file-name'] || `job_${jobId}_${fileDoc.id}.pdf`;
      const isColor = fileData['color'] === true;
      if (isColor) hasColorFile = true;
      else hasBwFile = true;

      const rawCopies = Number(fileData['copies'] || 1);
      const copies = Number.isInteger(rawCopies) && rawCopies >= 1 ? rawCopies : 1;
      const rawPages = Number(fileData['total-pages'] || 1);
      const pages = Number.isFinite(rawPages) && rawPages >= 1 ? rawPages : 1;
      const totalFilePages = copies * pages;

      const { filePath, displayFileName } = buildSafeTempFilePath(
        tempDir,
        jobId,
        fileDoc.id,
        rawFileName
      );

      const selection = selectTargetPrinter({ isColor, config, state });
      if (!selection.targetPrinter) {
        const msg = `${selection.reason} (cannot print ${displayFileName})`;
        console.error(`[ERROR] ${msg}`);
        fileFailures.push(msg);
        continue;
      }

      if (!downloadUrl) {
        const msg = `Missing download URL for file ${displayFileName}`;
        console.error(`[ERROR] ${msg}`);
        fileFailures.push(msg);
        continue;
      }

      const targetPrinter = selection.targetPrinter;
      const loadBucket = selection.loadBucket;

      if (loadBucket === 'color') {
        state.pendingColorPages += totalFilePages;
      } else {
        state.pendingBwPages += totalFilePages;
      }

      try {
        writeJobRecord(ledgerDir, jobId, {
          jobId,
          status: 'downloading',
          currentFile: fileDoc.id,
          printedFiles: succeededFilesList,
          totalFiles: filesSnap.docs.length,
        });

        console.log(`Downloading ${displayFileName}...`);
        await downloadFile(downloadUrl, filePath, fetchImpl);

        const isSharedQueue =
          Boolean(config.bwPrinter) &&
          Boolean(config.colorPrinter) &&
          config.bwPrinter === config.colorPrinter;
        const trayLabel = isSharedQueue
          ? 'Tray 1'
          : targetPrinter === config.colorPrinter
            ? 'Tray 2'
            : 'Tray 1';

        console.log(
          `Routing ${displayFileName} (${totalFilePages} pages) to [${isColor ? 'COLOR' : 'B&W'}] printer: ${targetPrinter} [${trayLabel}]`
        );
        console.log(
          `Current Load -> B&W: ${state.pendingBwPages} pages | Color: ${state.pendingColorPages} pages`
        );

        const printOptions = {
          printer: targetPrinter,
          copies,
          color: isColor,
          duplex: fileData['fb'] === true,
        };

        writeJobRecord(ledgerDir, jobId, {
          jobId,
          status: 'printing',
          currentFile: fileDoc.id,
          printedFiles: succeededFilesList,
          totalFiles: filesSnap.docs.length,
        });

        try {
          await printerMod.print(filePath, printOptions);
          console.log(`✅ Successfully printed ${displayFileName} on ${targetPrinter}`);
          succeededFiles += 1;
          succeededFilesList.push(fileDoc.id);
          writeJobRecord(ledgerDir, jobId, {
            jobId,
            status: 'printing',
            printedFiles: succeededFilesList,
            totalFiles: filesSnap.docs.length,
          });

          if (isSharedQueue) {
            printedOnBw = true;
          } else if (targetPrinter === config.colorPrinter) {
            printedOnColor = true;
          } else {
            printedOnBw = true;
          }
        } catch (printErr) {
          const cleanPrintErr = sanitizeLogMessage(printErr);
          console.error(`⚠️ Error printing to ${targetPrinter}: ${cleanPrintErr}.`);

          // Fallback rules:
          // - Color jobs NEVER fall back to B&W printer (would lose paid color output).
          // - B&W jobs may fall back to a DISTINCT configured colorPrinter in grayscale mode.
          if (
            !isColor &&
            targetPrinter === config.bwPrinter &&
            config.colorPrinter &&
            config.colorPrinter !== targetPrinter
          ) {
            try {
              console.log(
                `[FALLBACK] Routing B&W file ${displayFileName} to Color Printer (Tray 2): ${config.colorPrinter}`
              );
              await printerMod.print(filePath, {
                ...printOptions,
                printer: config.colorPrinter,
                color: false,
              });
              console.log(
                `✅ Successfully printed ${displayFileName} on fallback printer (${config.colorPrinter})`
              );
              succeededFiles += 1;
              succeededFilesList.push(fileDoc.id);
              writeJobRecord(ledgerDir, jobId, {
                jobId,
                status: 'printing',
                printedFiles: succeededFilesList,
                totalFiles: filesSnap.docs.length,
              });
              printedOnColor = true;
            } catch (fallbackErr) {
              const cleanFallbackErr = sanitizeLogMessage(fallbackErr);
              console.error(
                `❌ Fallback to Color Printer also failed for ${displayFileName}: ${cleanFallbackErr}`
              );
              fileFailures.push(`Print and fallback failed for ${displayFileName}: ${cleanFallbackErr}`);
            }
          } else if (isColor) {
            console.error(
              `❌ Fallback skipped: Color job ${displayFileName} cannot be sent to B&W printer.`
            );
            fileFailures.push(`Color print failed on ${targetPrinter}: ${cleanPrintErr}`);
          } else {
            console.error(`❌ No distinct fallback printer available for ${displayFileName}.`);
            fileFailures.push(`B&W print failed on ${targetPrinter}: ${cleanPrintErr}`);
          }
        }
      } catch (err) {
        const cleanErr = sanitizeLogMessage(err);
        console.error(`❌ Error downloading/processing file ${displayFileName}: ${cleanErr}`);
        fileFailures.push(`Download failed for ${displayFileName}: ${cleanErr}`);
      } finally {
        if (loadBucket === 'color') {
          state.pendingColorPages = Math.max(0, state.pendingColorPages - totalFilePages);
        } else {
          state.pendingBwPages = Math.max(0, state.pendingBwPages - totalFilePages);
        }

        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (_) {}
        }
      }
    }

    // Explicit failure outcome: NEVER mark job 'completed' if any file failed or zero files printed
    if (fileFailures.length > 0 || succeededFiles !== filesSnap.docs.length || succeededFiles === 0) {
      const reasonSummary = sanitizeLogMessage(fileFailures.join('; ') || 'Zero files printed').slice(0, 500);
      console.error(
        `[JOB FAILED] Job ${jobId} did not complete (${succeededFiles}/${filesSnap.docs.length} file(s) printed): ${reasonSummary}`
      );
      writeJobRecord(ledgerDir, jobId, {
        jobId,
        status: 'failed',
        error: reasonSummary,
        printedFiles: succeededFilesList,
        totalFiles: filesSnap.docs.length,
      });
      recordTrackedJob(failedJobs, jobId);
      await updateTaskStatusWithRetry(
        updateDocFn,
        taskDocRef,
        {
          status: 'failed',
          'failed-time': new Date(),
          'failure-reason': reasonSummary,
          'printed-files': succeededFiles,
          'total-files': filesSnap.docs.length,
        },
        statusRetryOpts
      );
      state.processingJobs.delete(jobId);
      return {
        outcome: 'failed',
        printedFiles: succeededFiles,
        totalFiles: filesSnap.docs.length,
        failures: fileFailures,
      };
    }

    const collectionTrays = [];
    if (printedOnBw) collectionTrays.push('Tray 1');
    if (printedOnColor) collectionTrays.push('Tray 2');

    if (collectionTrays.length === 0) {
      if (hasBwFile) collectionTrays.push('Tray 1');
      if (hasColorFile) collectionTrays.push('Tray 2');
      if (collectionTrays.length === 0) collectionTrays.push('Tray 1');
    }

    // Record 'printed' in durable ledger BEFORE Firestore status write so a crash never causes duplicate prints
    writeJobRecord(ledgerDir, jobId, {
      jobId,
      status: 'printed',
      printedFiles: succeededFilesList,
      totalFiles: filesSnap.docs.length,
      collectionTrays,
    });

    recordTrackedJob(state.completedJobs, jobId);

    console.log(
      `\n🎉 [KIOSK OUTPUT] Job ${jobId} finished! Collection Tray(s): ${collectionTrays.join(' and ')}`
    );

    await updateTaskStatusWithRetry(
      updateDocFn,
      taskDocRef,
      {
        status: 'completed',
        'completed-time': new Date(),
        'collection-trays': collectionTrays,
      },
      statusRetryOpts
    );

    // Terminal completion confirmed
    writeJobRecord(ledgerDir, jobId, {
      jobId,
      status: 'completed',
      printedFiles: succeededFilesList,
      totalFiles: filesSnap.docs.length,
      collectionTrays,
    });

    state.processingJobs.delete(jobId);
    console.log(`Updated job ${jobId} status to completed with collection-trays.`);

    return {
      outcome: 'completed',
      printedFiles: succeededFiles,
      totalFiles: filesSnap.docs.length,
      collectionTrays,
    };
  } catch (error) {
    const existingRec = getJobRecord(ledgerDir, jobId);
    if (existingRec && existingRec.status === 'printed') {
      writeJobRecord(ledgerDir, jobId, {
        ...existingRec,
        lastError: sanitizeLogMessage(error),
      });
    } else {
      writeJobRecord(ledgerDir, jobId, {
        jobId,
        status: 'failed',
        error: sanitizeLogMessage(error),
        printedFiles: succeededFilesList,
      });
    }
    state.processingJobs.delete(jobId);
    console.error(`[ERROR] Failed to process job ${jobId}: ${sanitizeLogMessage(error)}`);
    return {
      outcome: 'error',
      error: sanitizeLogMessage(error),
    };
  } finally {
    claim.release();
  }
}

/**
 * Starts the non-interactive PRINTELLECT Kiosk Print Daemon.
 * Supports explicit dependency injection in `deps` for isolated integration tests
 * while never substituting test configuration automatically in production.
 */
export async function startDaemon(deps = {}) {
  const argv = deps.argv || process.argv.slice(2);
  const env = deps.env || process.env;
  const exitFn = deps.exit || ((code) => process.exit(code));
  const loadConfigFn = deps.loadConfig || defaultLoadConfig;
  const firebaseAuth = deps.auth || defaultAuth;
  const firestoreDb = deps.db || defaultDb;
  const signInFn = deps.signInAnonymously || defaultSignInAnonymously;
  const collectionFn = deps.collection || defaultCollection;
  const queryFn = deps.query || defaultQuery;
  const whereFn = deps.where || defaultWhere;
  const onSnapshotFn = deps.onSnapshot || defaultOnSnapshot;
  const registerSignals = deps.registerSignals !== false;
  const state = deps.state || defaultState;

  const isSetup = argv.includes('--setup');
  if (isSetup) {
    console.log('Starting interactive printer setup wizard...');
    const { runSetupWizard } = await import('./setup.js');
    const result = await runSetupWizard();
    return exitFn(result.success ? 0 : 1);
  }

  // Kiosk Session ID supplied via environment variable or explicit CLI positional argument
  const sessionId = (env.KIOSK_SESSION_ID || argv.find((arg) => !arg.startsWith('--')) || '').trim();
  if (!sessionId) {
    console.error('\n[FATAL ERROR] Kiosk Session ID is required.');
    console.error('Provide it via environment variable KIOSK_SESSION_ID or argument:');
    console.error('  node index.js <SESSION_ID>\n');
    return exitFn(1);
  }

  // Ensure a single daemon instance is active on this host
  let daemonLockRelease = null;
  if (deps.acquireDaemonLock !== false) {
    try {
      const lockObj = acquireDaemonLock(deps.runDir);
      daemonLockRelease = lockObj.release;
    } catch (lockErr) {
      console.error(`\n[FATAL LOCK ERROR] ${sanitizeLogMessage(lockErr)}`);
      return exitFn(1);
    }
  }

  // Load configuration non-interactively
  let configData;
  try {
    configData = loadConfigFn();
  } catch (err) {
    console.error(`\n[FATAL CONFIG ERROR] ${sanitizeLogMessage(err)}`);
    console.error('Please configure printers using the setup wizard before starting the daemon:');
    console.error('  node setup.js   (or printellect-setup)\n');
    return exitFn(1);
  }

  const config = configData.config;
  console.log('\n--- Kiosk Configuration ---');
  console.log(`Config File   : ${configData.configPath} ${configData.isLegacy ? '(Legacy fallback)' : ''}`);
  console.log(`B&W Printer   : ${config.bwPrinter || '(None / Disabled)'}`);
  console.log(`Color Printer : ${config.colorPrinter || '(None / Disabled)'}`);
  console.log('---------------------------\n');

  console.log('Starting Kiosk Print Daemon...');
  console.log(`Listening for Kiosk Session ID: ${maskSessionId(sessionId)}`);

  try {
    await signInFn(firebaseAuth);
    console.log('Connected to Firebase.');
  } catch (error) {
    console.error('Firebase Auth Error:', sanitizeLogMessage(error));
    return exitFn(1);
  }

  const tasksRef = collectionFn(firestoreDb, 'tasks');
  const q = queryFn(
    tasksRef,
    whereFn('kiosk-session-id', '==', sessionId),
    whereFn('is-kiosk-job', '==', true)
  );

  console.log('Listening for print jobs (waiting for payment confirmation)...');

  const unsubscribe = onSnapshotFn(
    q,
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'removed') {
          continue;
        }
        const jobId = change.doc.id;
        const jobData = change.doc.data() || {};

        // Defense-in-depth session & kiosk-job check on top of Firestore server query
        if (
          jobData['kiosk-session-id'] !== undefined &&
          jobData['kiosk-session-id'] !== sessionId
        ) {
          continue;
        }
        if (jobData['is-kiosk-job'] === false) {
          continue;
        }

        // Strict payment confirmation & outlet gate: ONLY process paid 'on-queue' jobs assigned a shopid
        if (jobData.status === 'on-queue' && Boolean(jobData.shopid)) {
          const failedJobs = state.failedJobs || (state.failedJobs = new Set());
          if (
            state.processingJobs.has(jobId) ||
            state.completedJobs.has(jobId) ||
            failedJobs.has(jobId)
          ) {
            continue;
          }
          state.processingJobs.add(jobId);
          console.log(`\n[PAYMENT CLEARED] Processing Job ID: ${jobId}`);
          void processJob(jobId, jobData, config, { ...deps, db: firestoreDb, state });
        }
      }
    },
    (error) => {
      console.error('Firestore Listener Error:', sanitizeLogMessage(error));
    }
  );

  let shuttingDown = false;
  const handleShutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}. Unsubscribing Firestore listener and shutting down cleanly...`);
    try {
      unsubscribe();
    } catch (_) {}
    if (daemonLockRelease) {
      try {
        daemonLockRelease();
      } catch (_) {}
    }
    exitFn(0);
  };

  if (registerSignals) {
    process.once('SIGTERM', () => handleShutdown('SIGTERM'));
    process.once('SIGINT', () => handleShutdown('SIGINT'));
  }

  return {
    shutdown: handleShutdown,
    unsubscribe,
    state,
  };
}

const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
    process.argv[1].endsWith('index.js'));

if (isDirectExecution) {
  startDaemon();
}
