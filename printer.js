import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

let ptp = null;
if (isWindows) {
  try {
    ptp = (await import('pdf-to-printer')).default;
  } catch (err) {
    console.warn('[WARN] pdf-to-printer not loaded:', err.message);
  }
}

/**
 * Validates that a printer queue name is safe.
 * @param {string} queueName
 * @returns {boolean}
 */
export function isSafeQueueName(queueName) {
  if (!queueName || typeof queueName !== 'string') return false;
  const trimmed = queueName.trim();
  if (trimmed.length === 0 || trimmed.length > 128) return false;
  if (trimmed.startsWith('-')) return false;
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  if (/[\s/\\#]/.test(trimmed)) return false;
  return true;
}

/**
 * Returns a list of printer names available on the system.
 * Works on Windows (via pdf-to-printer) and Linux / macOS (via CUPS lpstat).
 */
export async function getPrinters() {
  if (isWindows && ptp) {
    return await ptp.getPrinters();
  }

  // Linux / macOS via CUPS
  try {
    // lpstat -e lists enabled printer names (one per line)
    const { stdout } = await execFileAsync('lpstat', ['-e']);
    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      return lines.map((name) => ({ name }));
    }
  } catch (_) {
    // Fallback to lpstat -p if -e is not supported on older CUPS versions
  }

  try {
    const { stdout } = await execFileAsync('lpstat', ['-p']);
    const lines = stdout.split('\n');
    const printers = [];
    for (const line of lines) {
      const match = line.match(/^printer\s+([^\s]+)/i);
      if (match) {
        printers.push({ name: match[1] });
      }
    }
    return printers;
  } catch (err) {
    console.error('Error fetching printers via lpstat:', err.message);
    return [];
  }
}

/**
 * Supported CUPS options for Canon MAXIFY GX6100 and standard CUPS drivers:
 * - cupsPrintQuality: Draft, Normal, High
 * - ColorModel: RGB, Gray
 * - MediaType: Stationery, Photographic, Auto
 */
const QUALITY_MAP = {
  draft: 'Draft',
  economical: 'Draft',
  normal: 'Normal',
  standard: 'Normal',
  high: 'High',
  best: 'High',
};

const MEDIA_TYPE_MAP = {
  stationery: 'Stationery',
  plain: 'Stationery',
  photographic: 'Photographic',
  photo: 'Photographic',
  auto: 'Auto',
};

/**
 * Prints a PDF file to the specified printer using CUPS `lp`.
 *
 * Options:
 *   - printer: string (target printer queue name)
 *   - copies: number (default 1)
 *   - quality: 'draft' | 'normal' | 'high' (default 'normal')
 *   - grayscale: boolean (true -> ColorModel=Gray, false -> ColorModel=RGB, default false)
 *   - color: boolean (legacy alias: true -> ColorModel=RGB, false -> ColorModel=Gray)
 *   - mediaType: 'Stationery' | 'Photographic' | 'Auto' (default 'Stationery')
 *   - isPhoto: boolean (if true and quality === 'high', mediaType defaults to 'Photographic')
 *   - duplex: boolean (true -> sides=two-sided-long-edge, false -> sides=one-sided)
 *   - scale: 'fit' | 'actual' | 'id' | 'fill' (default 'fit')
 *   - jobTitle: string (safe job identifier)
 */
export async function print(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('A valid PDF filePath is required for printing.');
  }

  const resolvedFilePath = path.resolve(filePath);

  if (isWindows && ptp) {
    const ptpOptions = {};
    if (options.printer) ptpOptions.printer = options.printer;
    if (options.copies) ptpOptions.copies = options.copies;
    return await ptp.print(resolvedFilePath, ptpOptions);
  }

  // Linux / CUPS printing via `lp`
  const args = [];

  // 1. Target printer
  if (options.printer) {
    const printerName = String(options.printer).trim();
    if (!isSafeQueueName(printerName)) {
      throw new Error(`Invalid or unsafe printer queue name: "${options.printer}".`);
    }
    args.push('-d', printerName);
  }

  // 2. Job title
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

  // 3. Copies
  if (options.copies !== undefined && options.copies !== null) {
    const copiesNum = Number(options.copies);
    if (!Number.isInteger(copiesNum) || copiesNum < 1) {
      throw new Error(`Invalid copies value: "${options.copies}". Must be a positive integer.`);
    }
    if (copiesNum > 1) {
      args.push('-n', String(copiesNum));
    }
  }

  // 4. Quality (cupsPrintQuality)
  // Verified options: Draft, Normal, High (default: Normal)
  const rawQuality = String(options.quality || 'normal').trim().toLowerCase();
  const cupsQuality = QUALITY_MAP[rawQuality] || 'Normal';
  args.push('-o', `cupsPrintQuality=${cupsQuality}`);

  // 5. Color mode (ColorModel)
  // Verified options: RGB, Gray (default: RGB)
  let isGray = false;
  if (options.grayscale !== undefined) {
    isGray = options.grayscale === true || String(options.grayscale).toLowerCase() === 'true';
  } else if (options.color !== undefined) {
    isGray = options.color === false || String(options.color).toLowerCase() === 'false';
  }
  const colorModel = isGray ? 'Gray' : 'RGB';
  args.push('-o', `ColorModel=${colorModel}`);

  // 6. Media Type (MediaType)
  // Verified options: Stationery (plain paper), Photographic, Auto (default: Stationery)
  let mediaType = 'Stationery';
  if (options.mediaType) {
    const rawMediaType = String(options.mediaType).trim().toLowerCase();
    mediaType = MEDIA_TYPE_MAP[rawMediaType] || 'Stationery';
  } else if (cupsQuality === 'High' && (options.isPhoto === true || options.isImage === true)) {
    mediaType = 'Photographic';
  }
  args.push('-o', `MediaType=${mediaType}`);

  // 7. Duplex (sides / Duplex)
  if (options.duplex === true) {
    args.push('-o', 'sides=two-sided-long-edge');
    args.push('-o', 'Duplex=DuplexNoTumble');
  } else if (options.duplex === false) {
    args.push('-o', 'sides=one-sided');
    args.push('-o', 'Duplex=None');
  }

  // 8. Scaling (print-scaling / fit-to-page)
  const scale = String(options.scale || options.scaling || 'fit').trim().toLowerCase();
  if (scale === 'actual' || scale === 'none') {
    args.push('-o', 'print-scaling=none');
  } else if (scale === 'fill') {
    args.push('-o', 'print-scaling=fill');
  } else {
    // Default fit
    args.push('-o', 'fit-to-page');
    args.push('-o', 'print-scaling=fit-to-page');
  }

  // 9. Input file
  args.push(resolvedFilePath);

  // Debug log printing the exact command line and flags
  const formattedArgs = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
  console.log(`[CUPS] Executing: lp ${formattedArgs}`);

  try {
    const { stdout, stderr } = await execFileAsync('lp', args);
    if (stderr && stderr.trim().length > 0) {
      console.warn(`[CUPS WARN] ${stderr.trim()}`);
    }
    return stdout;
  } catch (err) {
    const exitCode = err.code !== undefined ? err.code : (err.status !== undefined ? err.status : 'UNKNOWN');
    const stderrOutput = (err.stderr || '').trim();
    const errMsg = `CUPS printing failed (exit code ${exitCode}): ${stderrOutput || err.message}`;
    console.error(`[CUPS ERROR] ${errMsg}`);
    const wrapped = new Error(errMsg);
    wrapped.exitCode = exitCode;
    wrapped.stderr = stderrOutput;
    throw wrapped;
  }
}

export default {
  isSafeQueueName,
  getPrinters,
  print,
};
