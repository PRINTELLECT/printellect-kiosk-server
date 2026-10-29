import readline from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';
import { getPrinters } from './printer.js';
import { saveConfig, getConfigPath, validateConfig } from './config.js';

/**
 * Creates a readline interface for terminal prompts.
 */
function createPromptInterface(input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input, output });
  const ask = (query) => new Promise((resolve) => rl.question(query, resolve));
  const close = () => rl.close();
  return { ask, close };
}

/**
 * Pure function: Validates and creates a sanitized printer configuration object
 * from technician role selections.
 * 
 * Rules:
 * - At most one B&W queue and at most one Color queue.
 * - The same queue CAN be assigned to both B&W and Color (e.g. Canon_GX6100).
 * - At least one role must be assigned.
 * - Selected queue names must exist in availablePrinters.
 * 
 * @param {object} params
 * @param {Array<{ name: string }>} params.availablePrinters - List of detected printers.
 * @param {string|null} params.bwQueue - Name of queue for B&W (or null).
 * @param {string|null} params.colorQueue - Name of queue for Color (or null).
 * @returns {{ valid: boolean, config?: { bwPrinter: string|null, colorPrinter: string|null }, errors: string[] }}
 */
export function buildPrinterConfiguration({ availablePrinters, bwQueue, colorQueue }) {
  const errors = [];
  const printerNames = new Set(
    (availablePrinters || []).map((p) => (p.name || p).trim().toLowerCase())
  );

  let selectedBw = null;
  let selectedColor = null;

  if (bwQueue && typeof bwQueue === 'string' && bwQueue.trim()) {
    const trimmed = bwQueue.trim();
    if (!printerNames.has(trimmed.toLowerCase())) {
      errors.push(`Selected B&W queue "${trimmed}" does not exist in available printers.`);
    } else {
      selectedBw = trimmed;
    }
  }

  if (colorQueue && typeof colorQueue === 'string' && colorQueue.trim()) {
    const trimmed = colorQueue.trim();
    if (!printerNames.has(trimmed.toLowerCase())) {
      errors.push(`Selected Color queue "${trimmed}" does not exist in available printers.`);
    } else {
      selectedColor = trimmed;
    }
  }

  if (!selectedBw && !selectedColor) {
    errors.push('At least one printer role (B&W or Color) must be assigned.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    config: {
      bwPrinter: selectedBw,
      colorPrinter: selectedColor,
    },
    errors: [],
  };
}

/**
 * Runs the interactive printer setup wizard.
 * 
 * @param {object} [options]
 * @param {Function} [options.printerProvider] - Function returning Promise<Array<object>>.
 * @param {string} [options.targetPath] - Destination config file path.
 * @param {ReadableStream} [options.input] - Stdin stream.
 * @param {WritableStream} [options.output] - Stdout stream.
 * @returns {Promise<{ success: boolean, config?: object, configPath?: string, cancelled?: boolean }>}
 */
export async function runSetupWizard(options = {}) {
  const printerProvider = options.printerProvider || getPrinters;
  const targetPath = options.targetPath || getConfigPath();
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;

  const log = (msg = '') => output.write(`${msg}\n`);
  const prompt = createPromptInterface(input, output);

  try {
    log('\n======================================================');
    log('   PRINTELLECT KIOSK — PRINTER CONFIGURATION WIZARD   ');
    log('======================================================');
    log(`Target configuration: ${targetPath}\n`);

    let printers = [];
    while (true) {
      log('Scanning for available printers via CUPS / system drivers...');
      printers = await printerProvider();

      if (printers && printers.length > 0) {
        break;
      }

      log('\n⚠️  No printers detected on this system.');
      log('Troubleshooting tips:');
      log('  1. Ensure the printer USB cable is connected securely.');
      log('  2. Verify the printer is powered on and not in sleep mode.');
      log('  3. Check if CUPS service is running: sudo systemctl status cups');
      log('  4. If using USB IPP, verify ipp-usb status: sudo systemctl status ipp-usb');
      log('  5. List USB devices with: lsusb\n');

      const choice = (await prompt.ask('Options: [r] Retry scan, [q] Quit setup: ')).trim().toLowerCase();
      if (choice === 'q' || choice === 'quit' || choice === 'exit') {
        log('\nSetup cancelled by user. No configuration was saved.');
        return { success: false, cancelled: true };
      }
    }

    log(`\nFound ${printers.length} printer(s):\n`);
    printers.forEach((p, idx) => {
      const name = p.name || p;
      const status = p.status ? ` (Status: ${p.status})` : '';
      log(`  [${idx + 1}] ${name}${status}`);
    });
    log('');

    // If there is exactly one printer, provide a fast shortcut to assign it to both roles or choose
    let bwQueue = null;
    let colorQueue = null;

    if (printers.length === 1) {
      const singlePrinterName = printers[0].name || printers[0];
      log(`Detected single printer: "${singlePrinterName}".`);
      log('How would you like to configure this printer?');
      log('  [1] Assign to BOTH Black & White and Color (recommended for color MFPs like Canon GX6100)');
      log('  [2] Assign to Black & White ONLY');
      log('  [3] Assign to Color ONLY');
      log('  [q] Cancel setup');

      while (true) {
        const ans = (await prompt.ask('Select option [1-3, q]: ')).trim().toLowerCase();
        if (ans === '1') {
          bwQueue = singlePrinterName;
          colorQueue = singlePrinterName;
          break;
        } else if (ans === '2') {
          bwQueue = singlePrinterName;
          colorQueue = null;
          break;
        } else if (ans === '3') {
          bwQueue = null;
          colorQueue = singlePrinterName;
          break;
        } else if (ans === 'q' || ans === 'quit') {
          log('\nSetup cancelled. No configuration was saved.');
          return { success: false, cancelled: true };
        } else {
          log('Invalid selection. Please choose 1, 2, 3, or q.');
        }
      }
    } else {
      // Multiple printers detected: guide technician through B&W and Color role assignment
      log('--- Assign Black & White Printer Role ---');
      log('Select which queue will handle black & white print jobs:');
      printers.forEach((p, idx) => {
        log(`  [${idx + 1}] ${p.name || p}`);
      });
      log('  [s] Skip (No dedicated B&W printer)');
      log('  [q] Cancel');

      while (true) {
        const ans = (await prompt.ask('Select B&W printer: ')).trim().toLowerCase();
        if (ans === 's' || ans === 'skip') {
          bwQueue = null;
          break;
        }
        if (ans === 'q' || ans === 'quit') {
          log('\nSetup cancelled. No configuration was saved.');
          return { success: false, cancelled: true };
        }
        const num = parseInt(ans, 10);
        if (!isNaN(num) && num >= 1 && num <= printers.length) {
          bwQueue = printers[num - 1].name || printers[num - 1];
          log(`Selected B&W Queue: "${bwQueue}"`);
          break;
        }
        log(`Invalid input. Please enter a number between 1 and ${printers.length}, 's' to skip, or 'q' to quit.`);
      }

      log('\n--- Assign Color Printer Role ---');
      log('Select which queue will handle color print jobs:');
      printers.forEach((p, idx) => {
        const isAlreadyBw = (p.name || p) === bwQueue;
        const note = isAlreadyBw ? ' (Currently assigned to B&W as well)' : '';
        log(`  [${idx + 1}] ${p.name || p}${note}`);
      });
      log('  [s] Skip (No color printer)');
      log('  [q] Cancel');

      while (true) {
        const ans = (await prompt.ask('Select Color printer: ')).trim().toLowerCase();
        if (ans === 's' || ans === 'skip') {
          colorQueue = null;
          break;
        }
        if (ans === 'q' || ans === 'quit') {
          log('\nSetup cancelled. No configuration was saved.');
          return { success: false, cancelled: true };
        }
        const num = parseInt(ans, 10);
        if (!isNaN(num) && num >= 1 && num <= printers.length) {
          colorQueue = printers[num - 1].name || printers[num - 1];
          log(`Selected Color Queue: "${colorQueue}"`);
          break;
        }
        log(`Invalid input. Please enter a number between 1 and ${printers.length}, 's' to skip, or 'q' to quit.`);
      }
    }

    // Build and validate configuration
    const buildResult = buildPrinterConfiguration({
      availablePrinters: printers,
      bwQueue,
      colorQueue,
    });

    if (!buildResult.valid) {
      log(`\n❌ Configuration Error: ${buildResult.errors.join(' ')}`);
      log('Please rerun the wizard and ensure at least one printer role is assigned.\n');
      return { success: false, errors: buildResult.errors };
    }

    // Review Summary with technician
    log('\n----------------------------------------');
    log('       Configuration Review             ');
    log('----------------------------------------');
    log(`  Black & White Printer : ${buildResult.config.bwPrinter || '(None / Disabled)'}`);
    log(`  Color Printer         : ${buildResult.config.colorPrinter || '(None / Disabled)'}`);
    log(`  Target Path           : ${targetPath}`);
    log('----------------------------------------\n');

    const confirm = (await prompt.ask('Save this configuration? [Y/n]: ')).trim().toLowerCase();
    if (confirm === 'n' || confirm === 'no') {
      log('\nConfiguration was NOT saved. Exiting wizard.');
      return { success: false, cancelled: true };
    }

    // Save atomically
    saveConfig(buildResult.config, targetPath);

    log(`\n✅ Configuration successfully saved to: ${targetPath}`);
    log('The PRINTELLECT daemon will now use these printer settings.\n');

    return {
      success: true,
      config: buildResult.config,
      configPath: targetPath,
    };
  } finally {
    prompt.close();
  }
}

// Direct execution CLI entrypoint
const isDirectExecution = process.argv[1] && (
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith('setup.js')
);

if (isDirectExecution) {
  runSetupWizard()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('\n[FATAL ERROR] Wizard failed unexpectedly:', err);
      process.exit(1);
    });
}

export default {
  buildPrinterConfiguration,
  runSetupWizard,
};
