import { execFile } from 'child_process';
import { promisify } from 'util';

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
 * Prints a PDF file to the specified printer.
 * Options:
 *   - printer: string (target printer name)
 *   - copies: number (default 1)
 *   - color: boolean
 *   - duplex: boolean
 */
export async function print(filePath, options = {}) {
  if (isWindows && ptp) {
    const ptpOptions = {};
    if (options.printer) ptpOptions.printer = options.printer;
    if (options.copies) ptpOptions.copies = options.copies;
    return await ptp.print(filePath, ptpOptions);
  }

  // Linux / CUPS printing via `lp`
  const args = [];
  if (options.printer) {
    args.push('-d', options.printer);
  }
  if (options.copies && options.copies > 1) {
    args.push('-n', String(options.copies));
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
  args.push(filePath);

  console.log(`[CUPS] Executing: lp ${args.join(' ')}`);
  const { stdout, stderr } = await execFileAsync('lp', args);
  if (stderr && stderr.trim().length > 0) {
    console.warn(`[CUPS WARN] ${stderr}`);
  }
  return stdout;
}

export default {
  getPrinters,
  print,
};
