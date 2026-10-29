import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import {
  generateAcceptancePdf,
  parseCupsRequestId,
  isTargetQueueRequestId,
  runPrintAcceptance,
} from '../scripts/verify-print-acceptance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ACCEPTANCE_SCRIPT = path.join(ROOT_DIR, 'scripts', 'verify-print-acceptance.js');

describe('Phase 4.4 & Phase 5 — End-to-End CUPS Printing Acceptance Gate', () => {
  let suiteDir;
  let shimBinDir;
  let shimJsPath;
  let testDir;
  let stateFile;
  let logFile;
  let origPath;
  let origForceCups;
  let origMockNode;
  let origMockShim;
  let origMockState;
  let origMockLog;
  const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';

  before(() => {
    suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-cups-suite-'));
    shimBinDir = path.join(suiteDir, 'bin');
    fs.mkdirSync(shimBinDir, { recursive: true });

    shimJsPath = path.join(suiteDir, 'cups-shim.mjs');
    const shimCode = `
import fs from 'fs';

const [tool, ...args] = process.argv.slice(2);
const statePath = process.env.MOCK_CUPS_STATE_FILE;
const logPath = process.env.MOCK_CUPS_LOG_FILE;

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
fs.appendFileSync(logPath, JSON.stringify({ tool, args }) + '\\n');

function saveState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

if (tool === 'lpstat') {
  if (args[0] === '-p') {
    if (state.lpstatFail) {
      process.stderr.write('lpstat: Bad file descriptor\\n');
      process.exit(1);
    }
    for (const q of state.queues || []) {
      let st = q.status || 'idle';
      let det = q.details || (st === 'disabled' ? 'disabled since Oct 29 -Paused' : 'is idle. enabled since Oct 29');
      if (state.disableAfterSubmit && (state.submittedCount || 0) > 0 && q.name === state.disableQueueName) {
        st = 'disabled';
        det = 'disabled since Oct 29 - Printer fault / paper jam';
      }
      process.stdout.write(\`printer \${q.name} \${det}\\n\`);
    }
    process.exit(0);
  }
  if (args[0] === '-a') {
    const qName = args[1];
    const q = (state.queues || []).find((x) => x.name.toLowerCase() === String(qName || '').toLowerCase());
    if (!q) {
      process.stderr.write(\`lpstat: Invalid destination name in list "\${qName}".\\n\`);
      process.exit(1);
    }
    if (q.accepting === false) {
      process.stdout.write(\`\${q.name} not accepting requests since Oct 29 - Rejecting Jobs\\n\`);
      process.exit(0);
    }
    process.stdout.write(\`\${q.name} accepting requests since Oct 29\\n\`);
    process.exit(0);
  }
  if (args[0] === '-W' && args[1] === 'not-completed' && args[2] === '-o') {
    const targetQ = args[3];
    state.pollCount = (state.pollCount || 0) + 1;
    saveState();

    // Always report any unrelated active jobs on targetQ so we verify acceptance only tracks/cancels its own requestId
    for (const activeJob of state.unrelatedActiveJobs || []) {
      if (!targetQ || activeJob.startsWith(targetQ + '-')) {
        process.stdout.write(\`\${activeJob} customer 4096 Oct 29\\n\`);
      }
    }

    if (state.neverComplete) {
      process.stdout.write(\`\${state.lastRequestId} printellect 2048 Oct 29\\n\`);
      process.exit(0);
    }
    const targetPoll = state.completeOnPoll || 1;
    if (state.pollCount < targetPoll) {
      process.stdout.write(\`\${state.lastRequestId} printellect 2048 Oct 29\\n\`);
    }
    process.exit(0);
  }
  process.exit(0);
}

if (tool === 'lp') {
  const dIdx = args.indexOf('-d');
  const queue = dIdx >= 0 ? args[dIdx + 1] : 'default';
  const pdfFile = args[args.length - 1];

  if ((state.failQueues || []).includes(queue)) {
    process.stderr.write(\`lp: Error - queue '\${queue}' rejected submission.\\n\`);
    process.exit(1);
  }

  if (!fs.existsSync(pdfFile)) {
    process.stderr.write(\`lp: Error - unable to access "\${pdfFile}" - No such file or directory\\n\`);
    process.exit(1);
  }
  const header = fs.readFileSync(pdfFile).subarray(0, 8).toString('ascii');
  state.lastPdfHeader = header;
  state.submittedCount = (state.submittedCount || 0) + 1;

  if (state.omitRequestId) {
    saveState();
    process.stdout.write('queued without id\\n');
    process.exit(0);
  }

  if (state.overrideRequestId) {
    state.lastRequestId = state.overrideRequestId;
    saveState();
    process.stdout.write(\`request id is \${state.overrideRequestId} (1 file(s))\\n\`);
    process.exit(0);
  }

  const reqId = \`\${queue}-\${100 + state.submittedCount}\`;
  state.lastRequestId = reqId;
  saveState();
  process.stdout.write(\`request id is \${reqId} (1 file(s))\\n\`);
  process.exit(0);
}

if (tool === 'cancel') {
  state.canceledJobs = state.canceledJobs || [];
  state.canceledJobs.push(args[0]);
  state.unrelatedActiveJobs = (state.unrelatedActiveJobs || []).filter((j) => j !== args[0]);
  saveState();
  process.exit(0);
}

process.exit(1);
`;
    fs.writeFileSync(shimJsPath, shimCode, 'utf8');

    if (process.platform === 'win32') {
      const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
      assert.equal(fs.existsSync(cscPath), true, 'csc.exe required on Windows to compile execFile PE shims');
      const csPath = path.join(suiteDir, 'CupsShim.cs');
      const baseExe = path.join(suiteDir, 'shim.exe');
      const csSource = `
using System;
using System.Diagnostics;
using System.IO;
using System.Text;

class CupsShim {
  static string QuoteArg(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\\t', '"' }) < 0) return arg;
    var sb = new StringBuilder("\\"");
    int bs = 0;
    foreach (char c in arg) {
      if (c == '\\\\') { bs++; }
      else if (c == '"') { sb.Append('\\\\', bs * 2 + 1); sb.Append('"'); bs = 0; }
      else { if (bs > 0) { sb.Append('\\\\', bs); bs = 0; } sb.Append(c); }
    }
    if (bs > 0) sb.Append('\\\\', bs * 2);
    sb.Append("\\"");
    return sb.ToString();
  }

  static int Main(string[] args) {
    string tool = Path.GetFileNameWithoutExtension(Process.GetCurrentProcess().MainModule.FileName);
    string nodeExe = Environment.GetEnvironmentVariable("MOCK_NODE_EXE");
    string shimJs = Environment.GetEnvironmentVariable("MOCK_CUPS_SHIM_JS");
    var argBuilder = new StringBuilder();
    argBuilder.Append(QuoteArg(shimJs)).Append(" ").Append(QuoteArg(tool));
    foreach (string a in args) {
      argBuilder.Append(" ").Append(QuoteArg(a));
    }
    var psi = new ProcessStartInfo(nodeExe, argBuilder.ToString());
    psi.UseShellExecute = false;
    psi.RedirectStandardOutput = true;
    psi.RedirectStandardError = true;
    using (var p = Process.Start(psi)) {
      string stdout = p.StandardOutput.ReadToEnd();
      string stderr = p.StandardError.ReadToEnd();
      p.WaitForExit();
      Console.Out.Write(stdout);
      Console.Error.Write(stderr);
      return p.ExitCode;
    }
  }
}
`;
      fs.writeFileSync(csPath, csSource, 'utf8');
      const compileRes = spawnSync(cscPath, ['/nologo', '/target:exe', `/out:${baseExe}`, csPath], {
        encoding: 'utf8',
      });
      assert.equal(compileRes.status, 0, `csc.exe failed: ${compileRes.stdout}\n${compileRes.stderr}`);

      for (const tool of ['lpstat', 'lp', 'cancel']) {
        fs.copyFileSync(baseExe, path.join(shimBinDir, `${tool}.exe`));
      }
    } else {
      for (const tool of ['lpstat', 'lp', 'cancel']) {
        const script = `#!/usr/bin/env bash\nexec "${process.execPath}" "${shimJsPath}" "${tool}" "$@"\n`;
        fs.writeFileSync(path.join(shimBinDir, tool), script, { mode: 0o755 });
      }
    }
  });

  after(() => {
    if (suiteDir && fs.existsSync(suiteDir)) {
      try {
        fs.rmSync(suiteDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-print-acc-'));
    stateFile = path.join(testDir, 'cups-state.json');
    logFile = path.join(testDir, 'cups-invocations.jsonl');
    fs.writeFileSync(logFile, '');

    origPath = process.env[pathKey];
    origForceCups = process.env.PRINTELLECT_FORCE_CUPS;
    origMockNode = process.env.MOCK_NODE_EXE;
    origMockShim = process.env.MOCK_CUPS_SHIM_JS;
    origMockState = process.env.MOCK_CUPS_STATE_FILE;
    origMockLog = process.env.MOCK_CUPS_LOG_FILE;

    process.env[pathKey] = `${shimBinDir}${path.delimiter}${origPath || ''}`;
    process.env.PRINTELLECT_FORCE_CUPS = '1';
    process.env.MOCK_NODE_EXE = process.execPath;
    process.env.MOCK_CUPS_SHIM_JS = shimJsPath;
    process.env.MOCK_CUPS_STATE_FILE = stateFile;
    process.env.MOCK_CUPS_LOG_FILE = logFile;
  });

  afterEach(() => {
    process.env[pathKey] = origPath;
    if (origForceCups === undefined) delete process.env.PRINTELLECT_FORCE_CUPS;
    else process.env.PRINTELLECT_FORCE_CUPS = origForceCups;
    if (origMockNode === undefined) delete process.env.MOCK_NODE_EXE;
    else process.env.MOCK_NODE_EXE = origMockNode;
    if (origMockShim === undefined) delete process.env.MOCK_CUPS_SHIM_JS;
    else process.env.MOCK_CUPS_SHIM_JS = origMockShim;
    if (origMockState === undefined) delete process.env.MOCK_CUPS_STATE_FILE;
    else process.env.MOCK_CUPS_STATE_FILE = origMockState;
    if (origMockLog === undefined) delete process.env.MOCK_CUPS_LOG_FILE;
    else process.env.MOCK_CUPS_LOG_FILE = origMockLog;

    if (testDir && fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  function writeCupsState(stateObj) {
    fs.writeFileSync(stateFile, JSON.stringify(stateObj, null, 2));
  }

  function readInvocations() {
    return fs
      .readFileSync(logFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function writeConfig(cfgObj) {
    const cfgPath = path.join(testDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2) + '\n');
    return cfgPath;
  }

  it('should generate a spec-compliant single-page PDF-1.4 document with exact xref byte offsets', () => {
    const pdfBuf = generateAcceptancePdf([
      'Line 1: Printellect Acceptance (B&W)',
      'Line 2: Path C:\\test\\(escaped)',
    ]);
    const pdfStr = pdfBuf.toString('ascii');

    assert.ok(pdfStr.startsWith('%PDF-1.4\n'), 'PDF must begin with %PDF-1.4 header');
    assert.ok(pdfStr.endsWith('%%EOF\n'), 'PDF must terminate with %%EOF');
    assert.match(pdfStr, /\\\(escaped\\\)/, 'Parentheses must be escaped in PDF content stream');

    const startxrefMatch = pdfStr.match(/startxref\n(\d+)\n%%EOF/);
    assert.ok(startxrefMatch, 'startxref offset must be present');
    const startxref = Number(startxrefMatch[1]);
    assert.equal(pdfBuf.subarray(startxref, startxref + 5).toString('ascii'), 'xref\n');

    const xrefLines = pdfStr
      .slice(startxref)
      .split('\n')
      .filter((l) => /^\d{10} 00000 n $/.test(l));
    assert.equal(xrefLines.length, 5);
    xrefLines.forEach((line, idx) => {
      const offset = Number(line.slice(0, 10));
      const expectedPrefix = `${idx + 1} 0 obj\n`;
      const actualSlice = pdfBuf.subarray(offset, offset + expectedPrefix.length).toString('ascii');
      assert.equal(actualSlice, expectedPrefix, `xref object ${idx + 1} byte offset mismatch`);
    });
  });

  it('should parse CUPS request IDs accurately and reject malformed, option-flag, or cross-queue IDs', () => {
    assert.equal(parseCupsRequestId('request id is Canon_GX6100-42 (1 file(s))\n'), 'Canon_GX6100-42');
    assert.equal(parseCupsRequestId('request id is HP_LaserJet_Pro-109 (1 file(s))'), 'HP_LaserJet_Pro-109');
    assert.equal(parseCupsRequestId('request id is -a (1 file(s))'), null, 'Must reject -a option injection');
    assert.equal(parseCupsRequestId('request id is Canon_GX6100 (1 file(s))'), null, 'Must reject bare queue without job digits');
    assert.equal(parseCupsRequestId(''), null);
    assert.equal(parseCupsRequestId('queued silently without identifier'), null);

    assert.equal(isTargetQueueRequestId('Canon_GX6100-42', 'Canon_GX6100'), true);
    assert.equal(isTargetQueueRequestId('Other_Queue-42', 'Canon_GX6100'), false);
    assert.equal(isTargetQueueRequestId('-a', 'Canon_GX6100'), false);
    assert.equal(isTargetQueueRequestId('Canon_GX6100', 'Canon_GX6100'), false);
  });

  it('should validate healthy queues in --check-queues mode and mark physicalPrintTested=false', async () => {
    const cfgPath = writeConfig({
      bwPrinter: 'HP_LaserJet_BW',
      colorPrinter: 'Canon_GX6100_Color',
    });
    writeCupsState({
      queues: [
        { name: 'HP_LaserJet_BW', status: 'idle', accepting: true },
        { name: 'Canon_GX6100_Color', status: 'idle', accepting: true },
      ],
    });

    const res = await runPrintAcceptance({
      submitTestJob: false,
      configPath: cfgPath,
      allowNonServiceUser: true,
    });

    assert.equal(res.mode, 'check-queues');
    assert.equal(res.physicalPrintTested, false);
    assert.equal(res.checkedQueues.length, 2);
    assert.equal(res.checkedQueues[0].queueName, 'HP_LaserJet_BW');
    assert.equal(res.checkedQueues[1].queueName, 'Canon_GX6100_Color');

    const lpCalls = readInvocations().filter((i) => i.tool === 'lp');
    assert.equal(lpCalls.length, 0, '--check-queues must never submit a print job');
  });

  it('should fail queue validation if configured queue is missing, disabled, or rejecting requests', async () => {
    const cfgPath = writeConfig({ bwPrinter: 'Canon_GX6100', colorPrinter: null });

    writeCupsState({ queues: [{ name: 'Other_Printer', status: 'idle', accepting: true }] });
    await assert.rejects(
      () => runPrintAcceptance({ configPath: cfgPath, allowNonServiceUser: true }),
      /does not exist or is invisible/
    );

    writeCupsState({ queues: [{ name: 'Canon_GX6100', status: 'disabled', accepting: true }] });
    await assert.rejects(
      () => runPrintAcceptance({ configPath: cfgPath, allowNonServiceUser: true }),
      /is DISABLED in CUPS/
    );

    writeCupsState({ queues: [{ name: 'Canon_GX6100', status: 'idle', accepting: false }] });
    await assert.rejects(
      () => runPrintAcceptance({ configPath: cfgPath, allowNonServiceUser: true }),
      /not accepting print requests/
    );
  });

  it('should submit B&W grayscale single-sided and Color RGB duplex multi-copy jobs with explicit acceptance jobTitle (-t) and track spool completion', async () => {
    const cfgPath = writeConfig({
      bwPrinter: 'HP_LaserJet_BW',
      colorPrinter: 'Canon_GX6100_Color',
    });
    writeCupsState({
      queues: [
        { name: 'HP_LaserJet_BW', status: 'idle', accepting: true },
        { name: 'Canon_GX6100_Color', status: 'idle', accepting: true },
      ],
      completeOnPoll: 2,
    });

    // 1. B&W 1-copy grayscale single-sided
    const bwRes = await runPrintAcceptance({
      submitTestJob: true,
      configPath: cfgPath,
      role: 'bw',
      color: false,
      duplex: false,
      copies: 1,
      generateTestPdf: true,
      waitCompletionSec: 5,
      pollIntervalMs: 50,
      allowNonServiceUser: true,
    });

    assert.equal(bwRes.targetQueue, 'HP_LaserJet_BW');
    assert.equal(bwRes.requestId, 'HP_LaserJet_BW-101');
    assert.equal(bwRes.completionState, 'cups_spool_completed');
    assert.equal(bwRes.physicalPrintTested, false);
    assert.match(bwRes.acceptanceJobId, /^printellect-acceptance-bw-/);

    let lpCalls = readInvocations().filter((i) => i.tool === 'lp');
    assert.equal(lpCalls.length, 1);
    const bwArgs = lpCalls[0].args;
    assert.deepEqual(bwArgs.slice(0, -1), [
      '-d', 'HP_LaserJet_BW',
      '-t', bwRes.acceptanceJobId,
      '-o', 'ColorModel=Gray',
      '-o', 'sides=one-sided',
      '-o', 'fit-to-page',
    ]);
    assert.equal(fs.existsSync(bwArgs[bwArgs.length - 1]), false, 'Generated temp PDF must be cleaned up');

    // 2. Color 3-copy RGB two-sided-long-edge duplex
    const colorRes = await runPrintAcceptance({
      submitTestJob: true,
      configPath: cfgPath,
      role: 'color',
      color: true,
      duplex: true,
      copies: 3,
      generateTestPdf: true,
      waitCompletionSec: 5,
      pollIntervalMs: 50,
      allowNonServiceUser: true,
    });

    assert.equal(colorRes.targetQueue, 'Canon_GX6100_Color');
    assert.equal(colorRes.requestId, 'Canon_GX6100_Color-102');
    assert.equal(colorRes.completionState, 'cups_spool_completed');
    assert.match(colorRes.acceptanceJobId, /^printellect-acceptance-color-/);

    lpCalls = readInvocations().filter((i) => i.tool === 'lp');
    assert.equal(lpCalls.length, 2);
    const colorArgs = lpCalls[1].args;
    assert.deepEqual(colorArgs.slice(0, -1), [
      '-d', 'Canon_GX6100_Color',
      '-t', colorRes.acceptanceJobId,
      '-n', '3',
      '-o', 'ColorModel=RGB',
      '-o', 'sides=two-sided-long-edge',
      '-o', 'fit-to-page',
    ]);

    const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(savedState.lastPdfHeader, '%PDF-1.4');
  });

  it('should NEVER silently fall back to another printer when target role is null or target queue submission fails', async () => {
    const singleRoleCfg = writeConfig({
      bwPrinter: null,
      colorPrinter: 'Canon_GX6100_Color',
    });
    writeCupsState({
      queues: [{ name: 'Canon_GX6100_Color', status: 'idle', accepting: true }],
    });

    await assert.rejects(
      () =>
        runPrintAcceptance({
          submitTestJob: true,
          configPath: singleRoleCfg,
          role: 'bw',
          generateTestPdf: true,
          allowNonServiceUser: true,
        }),
      /Refusing to fall back to colorPrinter/
    );
    assert.equal(readInvocations().filter((i) => i.tool === 'lp').length, 0);

    const dualCfg = writeConfig({
      bwPrinter: 'HP_LaserJet_BW',
      colorPrinter: 'Canon_GX6100_Color',
    });
    writeCupsState({
      queues: [
        { name: 'HP_LaserJet_BW', status: 'idle', accepting: true },
        { name: 'Canon_GX6100_Color', status: 'idle', accepting: true },
      ],
      failQueues: ['HP_LaserJet_BW'],
    });

    await assert.rejects(
      () =>
        runPrintAcceptance({
          submitTestJob: true,
          configPath: dualCfg,
          role: 'bw',
          generateTestPdf: true,
          allowNonServiceUser: true,
        }),
      /rejected submission/
    );

    const lpInvocations = readInvocations().filter((i) => i.tool === 'lp');
    assert.equal(lpInvocations.length, 1, 'Must attempt target queue once and never try fallback queue');
    assert.equal(lpInvocations[0].args[1], 'HP_LaserJet_BW');
  });

  it('should cancel ONLY its own acceptance requestId on timeout/fault and NEVER cancel or interfere with unrelated active print jobs', async () => {
    const cfgPath = writeConfig({ bwPrinter: 'Canon_GX6100', colorPrinter: null });

    // 1. Unrelated customer jobs Canon_GX6100-41 and Other_Queue-77 are active when acceptance job Canon_GX6100-101 times out
    writeCupsState({
      queues: [
        { name: 'Canon_GX6100', status: 'idle', accepting: true },
        { name: 'Other_Queue', status: 'idle', accepting: true },
      ],
      unrelatedActiveJobs: ['Canon_GX6100-41', 'Other_Queue-77'],
      neverComplete: true,
    });

    await assert.rejects(
      () =>
        runPrintAcceptance({
          submitTestJob: true,
          configPath: cfgPath,
          role: 'bw',
          generateTestPdf: true,
          waitCompletionSec: 0.25,
          pollIntervalMs: 50,
          allowNonServiceUser: true,
        }),
      /Timed out waiting.*canceled stuck job/
    );
    let st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(st.canceledJobs, ['Canon_GX6100-101']);
    assert.deepEqual(
      st.unrelatedActiveJobs,
      ['Canon_GX6100-41', 'Other_Queue-77'],
      'Unrelated active jobs on the same and other queues must remain completely untouched'
    );

    // 2. Mid-job printer fault -> cancels ONLY own acceptance job Canon_GX6100-101
    writeCupsState({
      queues: [{ name: 'Canon_GX6100', status: 'idle', accepting: true }],
      unrelatedActiveJobs: ['Canon_GX6100-41'],
      neverComplete: true,
      disableAfterSubmit: true,
      disableQueueName: 'Canon_GX6100',
    });

    await assert.rejects(
      () =>
        runPrintAcceptance({
          submitTestJob: true,
          configPath: cfgPath,
          role: 'bw',
          generateTestPdf: true,
          waitCompletionSec: 2,
          pollIntervalMs: 50,
          allowNonServiceUser: true,
        }),
      /entered disabled\/unavailable state while processing job/
    );
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.deepEqual(st.canceledJobs, ['Canon_GX6100-101']);
    assert.deepEqual(st.unrelatedActiveJobs, ['Canon_GX6100-41']);

    // 3. If lp returned a cross-queue request ID ('Other_Queue-77') or option flag ('-a'), reject immediately without invoking cancel
    writeCupsState({
      queues: [{ name: 'Canon_GX6100', status: 'idle', accepting: true }],
      unrelatedActiveJobs: ['Other_Queue-77'],
      overrideRequestId: 'Other_Queue-77',
      neverComplete: true,
    });

    await assert.rejects(
      () =>
        runPrintAcceptance({
          submitTestJob: true,
          configPath: cfgPath,
          role: 'bw',
          generateTestPdf: true,
          waitCompletionSec: 1,
          pollIntervalMs: 50,
          allowNonServiceUser: true,
        }),
      /does not match target queue/
    );
    st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(st.canceledJobs || undefined, undefined, 'cancel must NEVER be invoked on a cross-queue ID');
  });

  it('should execute CLI verify-print-acceptance.js end-to-end and display Acceptance ID and mandatory physical verification notice', () => {
    const cfgPath = writeConfig({ bwPrinter: 'Canon_GX6100', colorPrinter: 'Canon_GX6100' });
    writeCupsState({
      queues: [{ name: 'Canon_GX6100', status: 'idle', accepting: true }],
      completeOnPoll: 1,
    });

    const cliRes = spawnSync(
      process.execPath,
      [
        ACCEPTANCE_SCRIPT,
        '--submit-test-job',
        '--config', cfgPath,
        '--role', 'bw',
        '--copies', '1',
        '--generate-test-pdf',
        '--wait-completion-sec', '3',
        '--allow-non-service-user',
      ],
      {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        env: process.env,
      }
    );

    assert.equal(cliRes.status, 0, `CLI failed: ${cliRes.stderr}\n${cliRes.stdout}`);
    assert.match(cliRes.stdout, /Acceptance ID\s+:\s+printellect-acceptance-bw-/);
    assert.match(cliRes.stdout, /CUPS Job ID\s+:\s+Canon_GX6100-101/);
    assert.match(cliRes.stdout, /Spool Status\s+:\s+cups_spool_completed/);
    assert.match(cliRes.stdout, /\[PHYSICAL VERIFICATION REQUIRED\]/);
  });
});
