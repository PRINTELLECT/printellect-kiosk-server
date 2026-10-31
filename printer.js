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
 * Resolves standard print scaling options to CUPS `-o` flags.
 * Supported values: 'fit' | 'actual' | 'fill' | 'auto' (default: 'auto')
 *
 * Mappings:
 *   - 'fit' | 'fit-to-page': -o print-scaling=fit -o fit-to-page
 *   - 'actual' | 'actual-size' | 'none' | 'id': -o print-scaling=none -o natural-scaling=100
 *   - 'fill' | 'expand': -o print-scaling=fill
 *   - 'auto' (default): -o print-scaling=auto
 *
 * @param {string} scalingInput
 * @returns {string[]} array of lp option flags
 */
export function resolveScalingOptions(scalingInput) {
  const normalized = String(scalingInput || 'auto').trim().toLowerCase();
  switch (normalized) {
    case 'fit':
    case 'fit-to-page':
      return ['-o', 'print-scaling=fit', '-o', 'fit-to-page'];
    case 'actual':
    case 'actual-size':
    case 'none':
    case 'id':
    case '100':
      return ['-o', 'print-scaling=none', '-o', 'natural-scaling=100'];
    case 'fill':
    case 'expand':
      return ['-o', 'print-scaling=fill'];
    case 'auto':
    default:
      return ['-o', 'print-scaling=auto'];
  }
}

/**
 * Resolves page orientation options to CUPS `-o` flags.
 * Supported values: 'portrait' / 'vertical' (default), 'landscape' / 'horizontal'
 *
 * Mappings:
 *   - 'landscape' | 'horizontal': -o orientation-requested=4 -o landscape
 *   - 'portrait' | 'vertical' (default): -o orientation-requested=3
 *
 * @param {string} orientationInput
 * @returns {string[]} array of lp option flags
 */
export function resolveOrientationOptions(orientationInput) {
  const normalized = String(orientationInput || 'portrait').trim().toLowerCase();
  if (normalized === 'landscape' || normalized === 'horizontal') {
    return ['-o', 'orientation-requested=4', '-o', 'landscape'];
  }
  return ['-o', 'orientation-requested=3'];
}

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
 *   - tumble: boolean (if true and landscape duplex, sides=two-sided-short-edge)
 *   - orientation: 'portrait' | 'landscape' (default 'portrait')
 *   - scaling / scale: 'fit' | 'actual' | 'fill' | 'auto' (default 'auto')
 *   - pageSize: string (e.g. 'A4', 'Letter')
 *   - jobTitle: string (safe job identifier)
 *   - jobId: string (optional task/job ID for structured logs)
 */
export async function print(filePath, options = {}) {
  if (!filePath || typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new Error('A valid PDF filePath is required for printing.');
  }

  const resolvedFilePath = path.resolve(filePath);
  const jobTag = options.jobId ? `[JOB ${options.jobId}] ` : '';

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

  // 7. Page Size (PageSize)
  if (options.pageSize || options.paperSize) {
    const rawPageSize = String(options.pageSize || options.paperSize).trim();
    if (/^[A-Za-z0-9_-]+$/.test(rawPageSize)) {
      args.push('-o', `PageSize=${rawPageSize}`);
    }
  }

  // 8. Orientation
  const orientationArgs = resolveOrientationOptions(options.orientation);
  args.push(...orientationArgs);

  // 9. Duplex (sides / Duplex)
  const isLandscape = String(options.orientation || '').trim().toLowerCase() === 'landscape' ||
                      String(options.orientation || '').trim().toLowerCase() === 'horizontal';
  const shouldTumble = options.tumble === true;

  if (options.duplex === true) {
    if (isLandscape && shouldTumble) {
      args.push('-o', 'sides=two-sided-short-edge');
      args.push('-o', 'Duplex=DuplexTumble');
    } else {
      args.push('-o', 'sides=two-sided-long-edge');
      args.push('-o', 'Duplex=DuplexNoTumble');
    }
  } else if (options.duplex === false) {
    args.push('-o', 'sides=one-sided');
    args.push('-o', 'Duplex=None');
  }

  // 10. Scaling (print-scaling / natural-scaling / fit-to-page)
  const scalingArgs = resolveScalingOptions(options.scaling || options.scale || options.scaleMode);
  args.push(...scalingArgs);

  // 11. Input file
  args.push(resolvedFilePath);

  // Debug log printing the exact command line and flags
  const formattedArgs = args.map((arg) => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
  console.log(`${jobTag}[CUPS] Executing: lp ${formattedArgs}`);

  try {
    const { stdout, stderr } = await execFileAsync('lp', args);
    if (stdout && stdout.trim().length > 0) {
      console.log(`${jobTag}[CUPS STDOUT] ${stdout.trim()}`);
    }
    if (stderr && stderr.trim().length > 0) {
      console.warn(`${jobTag}[CUPS STDERR/WARN] ${stderr.trim()}`);
    }
    return stdout;
  } catch (err) {
    const exitCode = err.code !== undefined ? err.code : (err.status !== undefined ? err.status : 'UNKNOWN');
    const stderrOutput = (err.stderr || '').trim();
    const stdoutOutput = (err.stdout || '').trim();
    const errMsg = `${jobTag}CUPS printing failed (exit code ${exitCode}): ${stderrOutput || err.message}`;
    console.error(`[CUPS ERROR] ${errMsg}`);
    if (stdoutOutput) {
      console.error(`${jobTag}[CUPS STDOUT ON ERROR] ${stdoutOutput}`);
    }
    const wrapped = new Error(errMsg);
    wrapped.exitCode = exitCode;
    wrapped.stderr = stderrOutput;
    wrapped.stdout = stdoutOutput;
    throw wrapped;
  }
}

export default {
  isSafeQueueName,
  getPrinters,
  resolveScalingOptions,
  resolveOrientationOptions,
  print,
};
