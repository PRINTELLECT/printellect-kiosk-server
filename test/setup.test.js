import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import {
  buildPrinterConfiguration,
  runSetupWizard,
  parseSetupCliArgs,
  runSetupCli,
} from '../setup.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('Setup Wizard - Printer Role Logic', () => {
  const samplePrinters = [
    { name: 'Canon_GX6100', status: 'idle' },
    { name: 'HP_LaserJet_Pro', status: 'idle' },
  ];

  it('should build valid configuration when two distinct printers are assigned', () => {
    const result = buildPrinterConfiguration({
      availablePrinters: samplePrinters,
      bwQueue: 'HP_LaserJet_Pro',
      colorQueue: 'Canon_GX6100',
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.config, {
      bwPrinter: 'HP_LaserJet_Pro',
      colorPrinter: 'Canon_GX6100',
    });
    assert.equal(result.errors.length, 0);
  });

  it('should support assigning the same physical queue to both B&W and Color', () => {
    const result = buildPrinterConfiguration({
      availablePrinters: samplePrinters,
      bwQueue: 'Canon_GX6100',
      colorQueue: 'Canon_GX6100',
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.config, {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'Canon_GX6100',
    });
  });

  it('should support single role assignment when B&W is skipped', () => {
    const result = buildPrinterConfiguration({
      availablePrinters: samplePrinters,
      bwQueue: null,
      colorQueue: 'Canon_GX6100',
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.config, {
      bwPrinter: null,
      colorPrinter: 'Canon_GX6100',
    });
  });

  it('should support single role assignment when Color is skipped', () => {
    const result = buildPrinterConfiguration({
      availablePrinters: samplePrinters,
      bwQueue: 'HP_LaserJet_Pro',
      colorQueue: null,
    });

    assert.equal(result.valid, true);
    assert.deepEqual(result.config, {
      bwPrinter: 'HP_LaserJet_Pro',
      colorPrinter: null,
    });
  });

  it('should reject configuration if both roles are skipped or omitted', () => {
    const result = buildPrinterConfiguration({
      availablePrinters: samplePrinters,
      bwQueue: null,
      colorQueue: null,
    });

    assert.equal(result.valid, false);
    assert.match(result.errors[0], /At least one printer role/);
  });

  it('should reject selection of a queue that does not exist in available printers', () => {
    const result = buildPrinterConfiguration({
      availablePrinters: samplePrinters,
      bwQueue: 'NonExistent_Printer',
      colorQueue: 'Canon_GX6100',
    });

    assert.equal(result.valid, false);
    assert.match(result.errors[0], /does not exist in available printers/);
  });
});

describe('Setup Wizard - Interactive Flow Simulation', () => {
  it('should handle zero detected printers and technician cancellation cleanly', async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    // Technician enters 'q' to quit
    input.write('q\n');

    const result = await runSetupWizard({
      printerProvider: async () => [],
      input,
      output,
    });

    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
  });

  it('should configure single printer to both roles through interactive prompt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-wizard-test-'));
    const targetPath = path.join(tempDir, 'config.json');

    const input = new PassThrough();
    const output = new PassThrough();

    // Reactively respond to prompts:
    // 1. Select option [1] (Both B&W and Color)
    // 2. Confirm save [y]
    output.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Select option')) {
        setImmediate(() => input.write('1\n'));
      } else if (text.includes('Save this configuration')) {
        setImmediate(() => input.write('y\n'));
      }
    });

    const result = await runSetupWizard({
      printerProvider: async () => [{ name: 'Canon_GX6100', status: 'idle' }],
      targetPath,
      input,
      output,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.config, {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'Canon_GX6100',
    });
    assert.equal(fs.existsSync(targetPath), true);

    const saved = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.deepEqual(saved, {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'Canon_GX6100',
    });

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should configure multiple distinct printers through interactive prompt', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-wizard-multi-test-'));
    const targetPath = path.join(tempDir, 'config.json');

    const input = new PassThrough();
    const output = new PassThrough();

    output.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Select B&W printer:')) {
        setImmediate(() => input.write('2\n')); // HP_LaserJet
      } else if (text.includes('Select Color printer:')) {
        setImmediate(() => input.write('1\n')); // Canon_GX6100
      } else if (text.includes('Save this configuration')) {
        setImmediate(() => input.write('y\n'));
      }
    });

    const result = await runSetupWizard({
      printerProvider: async () => [
        { name: 'Canon_GX6100', status: 'idle' },
        { name: 'HP_LaserJet_Pro', status: 'idle' },
      ],
      targetPath,
      input,
      output,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.config, {
      bwPrinter: 'HP_LaserJet_Pro',
      colorPrinter: 'Canon_GX6100',
    });
    assert.equal(fs.existsSync(targetPath), true);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should cleanly handle user choosing not to save configuration', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-wizard-cancel-test-'));
    const targetPath = path.join(tempDir, 'config.json');

    const input = new PassThrough();
    const output = new PassThrough();

    output.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Select option')) {
        setImmediate(() => input.write('1\n'));
      } else if (text.includes('Save this configuration')) {
        setImmediate(() => input.write('n\n'));
      }
    });

    const result = await runSetupWizard({
      printerProvider: async () => [{ name: 'Canon_GX6100', status: 'idle' }],
      targetPath,
      input,
      output,
    });

    assert.equal(result.success, false);
    assert.equal(result.cancelled, true);
    assert.equal(fs.existsSync(targetPath), false);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse CLI arguments and support non-interactive setup without launching wizard prompts', async () => {
    // 1. Argument parser validation
    const parsed = parseSetupCliArgs([
      '--bw', 'Canon_GX6100',
      '--color', 'Canon_GX6100',
      '--skip-verify-queues',
      '--config-path', '/tmp/test-cfg.json',
    ]);
    assert.equal(parsed.bwQueue, 'Canon_GX6100');
    assert.equal(parsed.colorQueue, 'Canon_GX6100');
    assert.equal(parsed.skipVerifyQueues, true);
    assert.equal(parsed.configPath, '/tmp/test-cfg.json');

    assert.throws(() => parseSetupCliArgs(['--unknown-flag']), /Unknown option: --unknown-flag/);
    assert.throws(() => parseSetupCliArgs(['--bw']), /Option --bw requires a queue name/);

    // 2. Non-interactive CLI run with queue validation
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-cli-setup-test-'));
    const targetPath = path.join(tempDir, 'config.json');
    const mockPrinters = [{ name: 'Canon_GX6100', status: 'idle' }];

    const output = new PassThrough();
    const okRes = await runSetupCli(
      ['--bw', 'Canon_GX6100', '--color', 'Canon_GX6100'],
      {
        printerProvider: async () => mockPrinters,
        targetPath,
        output,
      }
    );
    assert.equal(okRes.success, true);
    assert.equal(okRes.mode, 'non-interactive');
    assert.deepEqual(okRes.config, { bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' });
    assert.equal(fs.existsSync(targetPath), true);

    // 3. Rejects unknown printer in non-interactive mode
    const badRes = await runSetupCli(
      ['--bw', 'NonExistentQueue', '--color', 'Canon_GX6100'],
      {
        printerProvider: async () => mockPrinters,
        targetPath,
        output,
      }
    );
    assert.equal(badRes.success, false);
    assert.match(badRes.errors[0], /does not exist in available printers/);

    // 4. Diagnostic --list mode
    const listRes = await runSetupCli(['--list'], {
      printerProvider: async () => mockPrinters,
      output,
    });
    assert.equal(listRes.success, true);
    assert.equal(listRes.mode, 'list');
    assert.equal(listRes.printers.length, 1);

    // 5. Help mode
    const helpRes = await runSetupCli(['--help'], { output });
    assert.equal(helpRes.success, true);
    assert.equal(helpRes.mode, 'help');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
