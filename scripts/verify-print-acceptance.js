#!/usr/bin/env node

/**
 * PRINTELLECT Kiosk Server — End-to-End CUPS Printing Acceptance Gate
 *
 * Verifies that the unprivileged 'printellect' service account can:
 *   1. Read production configuration (/var/lib/printellect/config.json) without legacy fallback.
 *   2. Query CUPS queues (lpstat -p / lpstat -a) and confirm queues exist, are enabled,
 *      and are accepting requests.
 *   3. Submit a controlled 1-page PDF acceptance print job with a clear acceptance job
 *      identifier (-t printellect-acceptance-...) via the exact production printer.print()
 *      code path (printer selection, grayscale/color, copies, duplex) WITHOUT ever silently
 *      falling back to another printer.
 *   4. Track CUPS spool completion or detect queue faults/timeouts cleanly, canceling ONLY
 *      the validated acceptance job ID (<targetQueue>-<digits>) without ever interfering
 *      with unrelated active print jobs.
 *
 * IMPORTANT: Queue checks or mocked tests NEVER substitute for physical hardware
 * verification on the Raspberry Pi during the maintenance window.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { loadConfig } from '../config.js';
import * as printer from '../printer.js';

const execFileAsync = promisify(execFile);
const MAX_ACCEPTANCE_COPIES = 10;

function isCupsActive() {
  return process.platform !== 'win32' || process.env.PRINTELLECT_FORCE_CUPS === '1';
}

/**
 * Escapes parentheses and backslashes for PDF literal strings.
 */
function escapePdfText(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generates a spec-compliant, single-page A4 PDF-1.4 document with exact byte-offset xref table.
 * @param {string[]} lines - Lines of ASCII text to render on the acceptance page.
 * @returns {Buffer}
 */
export function generateAcceptancePdf(lines = []) {
  const safeLines = lines.length > 0 ? lines : ['PRINTELLECT Kiosk Printing Acceptance Test'];
  const streamOps = ['BT', '/F1 12 Tf', '48 780 Td', '18 TL'];
  safeLines.forEach((line, idx) => {
    if (idx === 0) {
      streamOps.push(`(${escapePdfText(line)}) Tj`);
    } else {
      streamOps.push(`T* (${escapePdfText(line)}) Tj`);
    }
  });
  streamOps.push('ET\n');
  const streamBody = streamOps.join('\n');
  const streamLength = Buffer.byteLength(streamBody, 'ascii');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamBody}endstream\nendobj\n`,
  ];

  const header = '%PDF-1.4\n';
  const offsets = [];
  let cursor = Buffer.byteLength(header, 'ascii');

  for (const obj of objects) {
    offsets.push(cursor);
    cursor += Buffer.byteLength(obj, 'ascii');
  }

  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(header + objects.join('') + xref + trailer, 'ascii');
}

/**
 * Extracts a CUPS request ID (e.g. "Canon_GX6100-42") from `lp` stdout.
 * Rejects tokens starting with '-' (option injection such as '-a') or missing numeric job suffix.
 * @param {string} lpStdout
 * @returns {string|null}
 */
export function parseCupsRequestId(lpStdout) {
  if (!lpStdout || typeof lpStdout !== 'string') return null;
  const match = lpStdout.match(/request id is\s+([^\s(]+)/i);
  if (!match) return null;
  const candidate = match[1].trim();
  if (candidate.startsWith('-') || !/^[A-Za-z0-9_@.+:-]+-\d+$/.test(candidate)) {
    return null;
  }
  return candidate;
}

/**
 * Confirms a parsed CUPS request ID strictly belongs to the intended targetQueue
 * (<targetQueue>-<numericJobId>) so `cancel` can NEVER target `-a`, a bare queue name,
 * or an unrelated printer queue's job.
 * @param {string|null} requestId
 * @param {string} targetQueue
 * @returns {boolean}
 */
export function isTargetQueueRequestId(requestId, targetQueue) {
  if (!requestId || !targetQueue) return false;
  if (requestId.startsWith('-')) return false;
  const pattern = new RegExp(`^${escapeRegex(targetQueue)}-\\d+$`, 'i');
  return pattern.test(requestId);
}

/**
 * Checks `lpstat -a <queueName>` to ensure CUPS queue is accepting requests.
 */
async function checkQueueAcceptingRequests(queueName) {
  if (!isCupsActive()) {
    return { accepting: true, raw: 'non-cups-platform' };
  }
  try {
    const { stdout } = await execFileAsync('lpstat', ['-a', queueName]);
    const line = stdout.trim();
    if (/not accepting|rejecting/i.test(line)) {
      return { accepting: false, raw: line };
    }
    if (/accepting requests/i.test(line)) {
      return { accepting: true, raw: line };
    }
    return { accepting: true, raw: line };
  } catch (err) {
    return { accepting: false, raw: err.stderr || err.message };
  }
}

/**
 * Validates a single configured target queue without falling back to any other queue.
 */
async function verifySingleQueueReadiness(queueName, roleLabel) {
  if (!printer.isSafeQueueName(queueName)) {
    throw new Error(`Configured ${roleLabel} queue name '${queueName}' is unsafe or invalid.`);
  }
  const queueCheck = await printer.validatePrinterQueue(queueName);
  if (!queueCheck.exists || !queueCheck.printer) {
    throw new Error(
      `Configured ${roleLabel} queue '${queueName}' does not exist or is invisible to user '${os.userInfo().username}' via lpstat.`
    );
  }
  if (queueCheck.printer.status === 'disabled') {
    throw new Error(
      `Configured ${roleLabel} queue '${queueName}' is DISABLED in CUPS (${queueCheck.printer.details || 'status=disabled'}).`
    );
  }

  const acceptCheck = await checkQueueAcceptingRequests(queueName);
  if (!acceptCheck.accepting) {
    throw new Error(
      `Configured ${roleLabel} queue '${queueName}' is not accepting print requests (${acceptCheck.raw}).`
    );
  }

  return {
    queueName: queueCheck.printer.name,
    status: queueCheck.printer.status,
    acceptingDetails: acceptCheck.raw,
  };
}

/**
 * Cancels ONLY the single validated acceptance requestId (never '-a', never a bare queue,
 * and never a job belonging to another queue).
 */
async function safeCancelOwnRequest(requestId, targetQueue) {
  if (!isTargetQueueRequestId(requestId, targetQueue)) {
    return false;
  }
  await execFileAsync('cancel', [requestId]).catch(() => {});
  return true;
}

/**
 * Executes the printing acceptance gate programmatically or from CLI.
 */
export async function runPrintAcceptance(opts = {}) {
  const mode = opts.submitTestJob ? 'submit' : 'check-queues';
  const expectedUser = opts.expectedUser || 'printellect';
  const currentUser = os.userInfo().username;

  if (
    process.platform === 'linux' &&
    !opts.allowNonServiceUser &&
    currentUser !== expectedUser
  ) {
    throw new Error(
      `Acceptance gate must run as service account '${expectedUser}' (current user: '${currentUser}'). ` +
      `Run with 'sudo -u ${expectedUser} ...' or pass --allow-non-service-user for non-service diagnostics.`
    );
  }

  // 1. Load production config strictly (never fall back to legacy ./config.json)
  const configData = loadConfig({
    customPath: opts.configPath || null,
    allowLegacyFallback: false,
  });
  const { bwPrinter, colorPrinter } = configData.config;

  // 2. Mode A: Non-printing queue & permission validation across configured roles
  if (mode === 'check-queues') {
    const checkedQueues = [];
    if (bwPrinter) {
      checkedQueues.push({
        role: 'bw',
        ...(await verifySingleQueueReadiness(bwPrinter, 'B&W (bwPrinter)')),
      });
    }
    if (colorPrinter) {
      checkedQueues.push({
        role: 'color',
        ...(await verifySingleQueueReadiness(colorPrinter, 'Color (colorPrinter)')),
      });
    }

    return {
      mode: 'check-queues',
      physicalPrintTested: false,
      user: currentUser,
      configPath: configData.configPath,
      checkedQueues,
    };
  }

  // 3. Mode B: Controlled single-queue print submission (STRICT ZERO FALLBACK)
  const role = opts.role || null;
  let targetQueue = null;

  if (role === 'bw') {
    if (!bwPrinter) {
      throw new Error(
        `Role 'bw' requested, but bwPrinter is null/disabled in ${configData.configPath}. Refusing to fall back to colorPrinter.`
      );
    }
    targetQueue = bwPrinter;
  } else if (role === 'color') {
    if (!colorPrinter) {
      throw new Error(
        `Role 'color' requested, but colorPrinter is null/disabled in ${configData.configPath}. Refusing to fall back to bwPrinter.`
      );
    }
    targetQueue = colorPrinter;
  } else if (!role && opts.printer && opts.allowUnconfiguredQueue) {
    targetQueue = opts.printer;
  } else {
    throw new Error(
      `--submit-test-job requires --role <bw|color> matching ${configData.configPath}.`
    );
  }

  if (opts.printer && opts.printer !== targetQueue && !opts.allowUnconfiguredQueue) {
    throw new Error(
      `Specified --printer '${opts.printer}' does not match configured ${role} queue '${targetQueue}' in ${configData.configPath}.`
    );
  }

  const copies = opts.copies !== undefined ? Number(opts.copies) : 1;
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_ACCEPTANCE_COPIES) {
    throw new Error(`--copies must be an integer between 1 and ${MAX_ACCEPTANCE_COPIES}.`);
  }

  const color = opts.color !== undefined ? Boolean(opts.color) : role === 'color';
  const duplex = opts.duplex !== undefined ? Boolean(opts.duplex) : false;
  const waitCompletionSec = opts.waitCompletionSec !== undefined ? Number(opts.waitCompletionSec) : 30;
  const pollIntervalMs = opts.pollIntervalMs !== undefined ? Number(opts.pollIntervalMs) : 1000;
  const cancelOnTimeout = opts.cancelOnTimeout !== false;

  if (Number.isNaN(waitCompletionSec) || waitCompletionSec < 0) {
    throw new Error('--wait-completion-sec must be a non-negative number.');
  }

  // Verify target queue readiness BEFORE submitting job
  const readiness = await verifySingleQueueReadiness(targetQueue, role || 'explicit');
  const acceptanceJobId = `printellect-acceptance-${role || 'explicit'}-${process.pid}-${Date.now()}`;

  let pdfPath = opts.filePath ? path.resolve(opts.filePath) : null;
  let generatedTempPdf = false;

  if (pdfPath) {
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`Test PDF file not found at: ${pdfPath}`);
    }
  } else if (opts.generateTestPdf) {
    const stamp = new Date().toISOString();
    const pdfBuf = generateAcceptancePdf([
      'PRINTELLECT KIOSK SERVER - MAINTENANCE ACCEPTANCE TEST',
      `Acceptance ID   : ${acceptanceJobId}`,
      `Timestamp (UTC) : ${stamp}`,
      `Service Account : ${currentUser}`,
      `Target Queue    : ${readiness.queueName} (role=${role || 'explicit'})`,
      `Print Options   : color=${color} (${color ? 'ColorModel=RGB' : 'ColorModel=Gray'}), duplex=${duplex} (${duplex ? 'two-sided-long-edge' : 'one-sided'}), copies=${copies}`,
      'Verification    : Confirm physical sheet output in expected tray. Zero fallback permitted.',
    ]);
    pdfPath = path.join(os.tmpdir(), `${acceptanceJobId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuf, { mode: 0o600 });
    generatedTempPdf = true;
  } else {
    throw new Error('Specify either --generate-test-pdf or --file <path.pdf> with --submit-test-job.');
  }

  try {
    // Submit via the exact production printer.print() code path with explicit jobTitle (ZERO fallback!)
    const lpStdout = await printer.print(pdfPath, {
      printer: readiness.queueName,
      jobTitle: acceptanceJobId,
      copies,
      color,
      duplex,
    });

    const requestId = parseCupsRequestId(lpStdout);
    if (isCupsActive()) {
      if (!requestId) {
        throw new Error(
          `CUPS 'lp' command exited 0 on queue '${readiness.queueName}', but returned no recognizable request ID. Output: "${String(lpStdout || '').trim()}"`
        );
      }
      if (!isTargetQueueRequestId(requestId, readiness.queueName)) {
        throw new Error(
          `CUPS 'lp' returned request ID '${requestId}' that does not match target queue '${readiness.queueName}'. Refusing to track or cancel unrelated queue ID.`
        );
      }
    }

    let completionState = 'submitted_no_wait';

    if (isCupsActive() && waitCompletionSec > 0 && requestId) {
      const deadline = Date.now() + waitCompletionSec * 1000;
      completionState = 'pending';

      while (Date.now() <= deadline) {
        // 1. Check if queue faulted/disabled mid-job
        const qStatus = await printer.validatePrinterQueue(readiness.queueName);
        if (!qStatus.exists || (qStatus.printer && qStatus.printer.status === 'disabled')) {
          if (cancelOnTimeout) {
            await safeCancelOwnRequest(requestId, readiness.queueName);
          }
          throw new Error(
            `Target queue '${readiness.queueName}' entered disabled/unavailable state while processing job '${requestId}'.`
          );
        }

        // 2. Check active/not-completed jobs on targetQueue
        const { stdout: pendingOut } = await execFileAsync('lpstat', [
          '-W',
          'not-completed',
          '-o',
          readiness.queueName,
        ]);
        const activeIds = pendingOut
          .split(/\r?\n/)
          .map((l) => l.trim().split(/\s+/)[0])
          .filter(Boolean);

        if (!activeIds.includes(requestId)) {
          completionState = 'cups_spool_completed';
          break;
        }

        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      if (completionState !== 'cups_spool_completed') {
        let canceled = false;
        if (cancelOnTimeout) {
          canceled = await safeCancelOwnRequest(requestId, readiness.queueName);
        }
        throw new Error(
          `Timed out waiting ${waitCompletionSec}s for CUPS job '${requestId}' to complete on '${readiness.queueName}'` +
          `${canceled ? ' (canceled stuck job in CUPS queue)' : ''}.`
        );
      }
    }

    return {
      mode: 'submit',
      physicalPrintTested: false,
      user: currentUser,
      configPath: configData.configPath,
      role,
      targetQueue: readiness.queueName,
      acceptanceJobId,
      options: { copies, color, duplex },
      requestId,
      completionState,
      lpOutput: String(lpStdout || '').trim(),
    };
  } finally {
    if (generatedTempPdf && pdfPath && fs.existsSync(pdfPath)) {
      try {
        fs.unlinkSync(pdfPath);
      } catch (_) {}
    }
  }
}

function parseBoolArg(val, flagName) {
  if (val === 'true' || val === '1') return true;
  if (val === 'false' || val === '0') return false;
  throw new Error(`Invalid boolean value '${val}' for ${flagName} (expected true or false).`);
}

function printHelp() {
  console.log(`PRINTELLECT Kiosk Server — CUPS Printing Acceptance Gate

Usage:
  sudo -u printellect node scripts/verify-print-acceptance.js --check-queues [OPTIONS]
  sudo -u printellect node scripts/verify-print-acceptance.js --submit-test-job --role <bw|color> --generate-test-pdf [OPTIONS]

Modes:
  --check-queues                 Verify config.json readability and CUPS queue enabled/accepting state (no page printed)
  --submit-test-job              Submit a controlled acceptance job to a single configured queue (zero fallback)

Options:
  --config <PATH>                Override config.json path (defaults to PRINTELLECT_CONFIG_PATH or /var/lib/printellect/config.json)
  --role <bw|color>              Configured printer role to test
  --printer <QUEUE>              Assert exact expected CUPS queue name
  --color <true|false>           Explicit ColorModel (true -> RGB, false -> Gray; defaults to role)
  --duplex <true|false>          Explicit duplex mode (true -> two-sided-long-edge, false -> one-sided; default: false)
  --copies <1..10>               Number of copies (default: 1)
  --generate-test-pdf            Generate a temporary 1-page A4 PDF-1.4 acceptance sheet
  --file <PATH>                  Path to an explicit PDF test page
  --wait-completion-sec <SEC>    Seconds to poll CUPS queue for job completion (default: 30, 0 to skip)
  --no-cancel-on-timeout         Do not run 'cancel <jobId>' if job times out in queue
  --allow-non-service-user       Allow execution as a user other than 'printellect' (diagnostics/testing only)
  --allow-unconfigured-queue     Allow testing an explicit --printer not listed in config.json
  -h, --help                     Show this help message
`);
}

async function cliMain() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    submitTestJob: false,
    configPath: null,
    role: null,
    printer: null,
    color: undefined,
    duplex: undefined,
    copies: 1,
    generateTestPdf: false,
    filePath: null,
    waitCompletionSec: 30,
    cancelOnTimeout: true,
    allowNonServiceUser: false,
    allowUnconfiguredQueue: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--check-queues') {
      opts.submitTestJob = false;
    } else if (a === '--submit-test-job') {
      opts.submitTestJob = true;
    } else if (a === '--config' && args[i + 1]) {
      opts.configPath = args[++i];
    } else if (a === '--role' && args[i + 1]) {
      opts.role = args[++i];
    } else if (a === '--printer' && args[i + 1]) {
      opts.printer = args[++i];
    } else if (a === '--color' && args[i + 1]) {
      opts.color = parseBoolArg(args[++i], '--color');
    } else if (a === '--duplex' && args[i + 1]) {
      opts.duplex = parseBoolArg(args[++i], '--duplex');
    } else if (a === '--copies' && args[i + 1]) {
      opts.copies = Number(args[++i]);
    } else if (a === '--generate-test-pdf') {
      opts.generateTestPdf = true;
    } else if (a === '--file' && args[i + 1]) {
      opts.filePath = args[++i];
    } else if (a === '--wait-completion-sec' && args[i + 1]) {
      opts.waitCompletionSec = Number(args[++i]);
    } else if (a === '--no-cancel-on-timeout') {
      opts.cancelOnTimeout = false;
    } else if (a === '--allow-non-service-user') {
      opts.allowNonServiceUser = true;
    } else if (a === '--allow-unconfigured-queue') {
      opts.allowUnconfiguredQueue = true;
    } else {
      throw new Error(`Unknown or incomplete option: ${a}`);
    }
  }

  const res = await runPrintAcceptance(opts);

  console.log('==========================================================');
  console.log('   PRINTELLECT — CUPS PRINTING ACCEPTANCE GATE            ');
  console.log('==========================================================');
  console.log(`Executing User : ${res.user}`);
  console.log(`Config File    : ${res.configPath}`);

  if (res.mode === 'check-queues') {
    for (const q of res.checkedQueues) {
      console.log(`Verified Queue : [${q.role.toUpperCase()}] ${q.queueName} (status=${q.status}, ${q.acceptingDetails})`);
    }
    console.log('Result         : QUEUE_PREFLIGHT_ONLY');
    console.log('[NOTICE] Queue visibility & accepting state verified; NO physical page was submitted or printed.');
  } else {
    console.log(`Target Queue   : [${(res.role || 'explicit').toUpperCase()}] ${res.targetQueue} (zero fallback)`);
    console.log(`Acceptance ID  : ${res.acceptanceJobId}`);
    console.log(`Print Options  : color=${res.options.color}, duplex=${res.options.duplex}, copies=${res.options.copies}`);
    console.log(`CUPS Job ID    : ${res.requestId || '(non-CUPS backend)'}`);
    console.log(`Spool Status   : ${res.completionState}`);
    console.log('[PHYSICAL VERIFICATION REQUIRED] Confirm physical page output in tray with expected color/duplex/copies before final cutover approval.');
  }
  console.log('==========================================================');
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  cliMain()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[PRINT ACCEPTANCE FAILED] ${err.message}`);
      process.exit(1);
    });
}
