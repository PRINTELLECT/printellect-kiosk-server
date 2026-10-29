import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';
const useWindowsBackend = () => isWindows && process.env.PRINTELLECT_FORCE_CUPS !== '1';

let ptp = null;
if (isWindows) {
  try {
    ptp = (await import('pdf-to-printer')).default;
  } catch (err) {
    console.warn('[WARN] pdf-to-printer not loaded:', err.message);
  }
}

/**
 * Validates that a printer queue name is safe to pass to subprocess arguments
 * (non-empty, does not start with '-' to prevent CLI option injection, no control characters,
 * and on CUPS backends no whitespace or path separators).
 * @param {string} queueName
 * @param {{ cupsStrict?: boolean }} [opts]
 * @returns {boolean}
 */
export function isSafeQueueName(queueName, opts = {}) {
  if (!queueName || typeof queueName !== 'string') return false;
  const trimmed = queueName.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (trimmed.startsWith('-')) return false;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  const cupsStrict = opts.cupsStrict !== undefined ? opts.cupsStrict : !useWindowsBackend();
  if (cupsStrict && /[\s/\\#]/.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Returns a list of printer names and their status available on the system.
 * Works on Windows (via pdf-to-printer) and Linux / macOS (via CUPS lpstat).
 */
export async function getPrinters() {
  if (useWindowsBackend() && ptp) {
    const list = await ptp.getPrinters();
    return list.map((p) => ({
      name: p.name || p,
      status: 'available',
    }));
  }

  // Linux / macOS via CUPS
  // First query lpstat -p to get rich status (idle, printing, disabled)
  try {
    const { stdout } = await execFileAsync('lpstat', ['-p']);
    const lines = stdout.split('\n');
    const printers = [];
    for (const line of lines) {
      const match = line.match(/^printer\s+([^\s]+)\s+(.*)/i);
      if (match) {
        const name = match[1];
        const statusDetails = match[2] || '';
        let status = 'available';
        if (/disabled/i.test(statusDetails)) {
          status = 'disabled';
        } else if (/idle/i.test(statusDetails)) {
          status = 'idle';
        } else if (/printing/i.test(statusDetails)) {
          status = 'printing';
        }
        printers.push({ name, status, details: statusDetails });
      }
    }
    if (printers.length > 0) {
      return printers;
    }
  } catch (_) {
    // Fall back to lpstat -e if lpstat -p fails
  }

  try {
    // lpstat -e lists enabled printer names (one per line)
    const { stdout } = await execFileAsync('lpstat', ['-e']);
    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines.map((name) => ({ name, status: 'enabled' }));
    }
  } catch (err) {
    console.error('Error fetching printers via lpstat:', err.message);
  }

  return [];
}

/**
 * Validates whether a specific printer queue exists in the system.
 * @param {string} queueName
 * @returns {Promise<{ exists: boolean, printer: { name: string, status?: string } | null }>}
 */
export async function validatePrinterQueue(queueName) {
  if (!isSafeQueueName(queueName)) {
    return { exists: false, printer: null };
  }
  const printers = await getPrinters();
  const normalized = queueName.trim().toLowerCase();
  const matched = printers.find((p) => (p.name || p).toLowerCase() === normalized);
  return {
    exists: Boolean(matched),
    printer: matched || null,
  };
}

/**
 * Prints a PDF file to the specified printer.
 * Explicit target printer is mandatory — never falls back silently to an arbitrary or default printer.
 *
 * Options:
 *   - printer: string (required target printer queue name)
 *   - copies: number (default 1)
 *   - color: boolean
 *   - duplex: boolean
 *   - jobTitle: string (optional safe CUPS job title identifier)
 */
export async function print(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('A valid PDF filePath is required for printing.');
  }

  const targetPrinter = typeof options.printer === 'string' ? options.printer.trim() : '';
  if (!targetPrinter) {
    throw new Error(
      'Explicit target printer queue (options.printer) is required; silent fallback to system default printer is prohibited.'
    );
  }
  if (!isSafeQueueName(targetPrinter)) {
    throw new Error(`Unsafe or invalid printer queue name rejected: "${targetPrinter}".`);
  }

  const resolvedFilePath = path.resolve(filePath);

  if (useWindowsBackend() && ptp) {
    const ptpOptions = { printer: targetPrinter };
    if (options.copies) ptpOptions.copies = options.copies;
    return await ptp.print(resolvedFilePath, ptpOptions);
  }

  // Linux / CUPS printing via `lp` (execFile without shell)
  const args = ['-d', targetPrinter];

  if (options.jobTitle !== undefined && options.jobTitle !== null) {
    const safeTitle = String(options.jobTitle)
      .trim()
      .replace(/[^A-Za-z0-9_.: -]/g, '_')
      .replace(/^-+/, '')
      .slice(0, 120);
    if (safeTitle.length > 0) {
      args.push('-t', safeTitle);
    }
  }

  if (options.copies !== undefined && options.copies !== null) {
    const copiesNum = Number(options.copies);
    if (!Number.isInteger(copiesNum) || copiesNum < 1) {
      throw new Error(`Invalid copies value: "${options.copies}". Must be a positive integer.`);
    }
    if (copiesNum > 1) {
      args.push('-n', String(copiesNum));
    }
  }
  if (options.color !== undefined) {
    args.push('-o', options.color ? 'ColorModel=RGB' : 'ColorModel=Gray');
  }
  if (options.duplex === true) {
    args.push('-o', 'sides=two-sided-long-edge');
  } else if (options.duplex === false) {
    args.push('-o', 'sides=one-sided');
  }

  // Fit to page by default on CUPS
  args.push('-o', 'fit-to-page');
  args.push(resolvedFilePath);

  console.log(`[CUPS] Executing: lp ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync('lp', args);
  if (stderr && stderr.trim().length > 0) {
    console.warn(`[CUPS WARN] ${stderr}`);
  }
  return stdout;
}

export default {
  isSafeQueueName,
  getPrinters,
  validatePrinterQueue,
  print,
};
