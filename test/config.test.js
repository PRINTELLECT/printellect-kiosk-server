import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  validateConfig,
  saveConfig,
  loadConfig,
  migrateLegacyConfig,
  ConfigError,
  ConfigConflictError,
} from '../config.js';

describe('Config Module - Validation', () => {
  it('should accept a valid configuration with both B&W and Color printers', () => {
    const raw = {
      bwPrinter: 'Canon_MF460',
      colorPrinter: 'HP_SmartTank_660',
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, true);
    assert.deepEqual(result.config, {
      bwPrinter: 'Canon_MF460',
      colorPrinter: 'HP_SmartTank_660',
    });
    assert.equal(result.errors.length, 0);
  });

  it('should accept a shared queue where one physical printer handles both roles', () => {
    const raw = {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'Canon_GX6100',
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, true);
    assert.equal(result.config.bwPrinter, 'Canon_GX6100');
    assert.equal(result.config.colorPrinter, 'Canon_GX6100');
  });

  it('should accept a configuration with only B&W printer', () => {
    const raw = {
      bwPrinter: 'Canon_MF460',
      colorPrinter: null,
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, true);
    assert.equal(result.config.bwPrinter, 'Canon_MF460');
    assert.equal(result.config.colorPrinter, null);
  });

  it('should accept a configuration with only Color printer', () => {
    const raw = {
      bwPrinter: null,
      colorPrinter: 'HP_SmartTank_660',
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, true);
    assert.equal(result.config.bwPrinter, null);
    assert.equal(result.config.colorPrinter, 'HP_SmartTank_660');
  });

  it('should trim whitespace around printer names', () => {
    const raw = {
      bwPrinter: '   Canon_MF460   ',
      colorPrinter: ' HP_SmartTank_660 ',
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, true);
    assert.equal(result.config.bwPrinter, 'Canon_MF460');
    assert.equal(result.config.colorPrinter, 'HP_SmartTank_660');
  });

  it('should reject configuration if both printers are null or omitted', () => {
    const raw = {
      bwPrinter: null,
      colorPrinter: null,
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /At least one printer role/);
  });

  it('should reject non-object values', () => {
    assert.equal(validateConfig(null).valid, false);
    assert.equal(validateConfig(undefined).valid, false);
    assert.equal(validateConfig('string').valid, false);
    assert.equal(validateConfig([1, 2, 3]).valid, false);
  });

  it('should reject unknown keys in configuration', () => {
    const raw = {
      bwPrinter: 'Canon_MF460',
      colorPrinter: null,
      unexpectedField: 'malicious_value',
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /Unknown configuration keys/);
  });

  it('should reject empty or blank printer name strings', () => {
    const raw = {
      bwPrinter: '    ',
      colorPrinter: null,
    };
    const result = validateConfig(raw);
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /must be a non-empty string or null/);
  });
});

describe('Config Module - Atomic Persistence & Loading', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should atomically save valid configuration to disk', () => {
    const targetPath = path.join(tempDir, 'subfolder', 'config.json');
    const validConfig = {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'Canon_GX6100',
    };

    const savedPath = saveConfig(validConfig, targetPath);
    assert.equal(savedPath, targetPath);
    assert.equal(fs.existsSync(targetPath), true);

    const savedRaw = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.deepEqual(savedRaw, validConfig);
  });

  it('should throw ConfigError when trying to save invalid configuration', () => {
    const targetPath = path.join(tempDir, 'config.json');
    const invalidConfig = {
      bwPrinter: null,
      colorPrinter: null,
    };

    assert.throws(
      () => saveConfig(invalidConfig, targetPath),
      ConfigError
    );
    assert.equal(fs.existsSync(targetPath), false);
  });

  it('should load configuration from explicit custom path', () => {
    const targetPath = path.join(tempDir, 'custom.json');
    const validConfig = {
      bwPrinter: 'LaserJet_Bw',
      colorPrinter: null,
    };
    saveConfig(validConfig, targetPath);

    const loaded = loadConfig({ customPath: targetPath });
    assert.deepEqual(loaded.config, validConfig);
    assert.equal(loaded.configPath, targetPath);
    assert.equal(loaded.isLegacy, false);
  });

  it('should throw ConfigError when configuration file is missing', () => {
    const nonExistentPath = path.join(tempDir, 'missing.json');
    assert.throws(
      () => loadConfig({ customPath: nonExistentPath }),
      (err) => err instanceof ConfigError && /not found/i.test(err.message)
    );
  });

  it('should throw ConfigError when configuration file has malformed JSON', () => {
    const targetPath = path.join(tempDir, 'broken.json');
    fs.writeFileSync(targetPath, '{ this is not valid json :;;;');

    assert.throws(
      () => loadConfig({ customPath: targetPath }),
      (err) => err instanceof ConfigError && /malformed JSON/i.test(err.message)
    );
  });

  it('should throw ConfigError when configuration file violates schema', () => {
    const targetPath = path.join(tempDir, 'invalid-schema.json');
    fs.writeFileSync(targetPath, JSON.stringify({ bwPrinter: 12345 }));

    assert.throws(
      () => loadConfig({ customPath: targetPath }),
      (err) => err instanceof ConfigError && /Invalid configuration/i.test(err.message)
    );
  });
});

describe('Config Module - Safe Legacy Migration', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'printellect-migrate-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should cleanly report when legacy source file does not exist', () => {
    const sourcePath = path.join(tempDir, 'legacy.json');
    const targetPath = path.join(tempDir, 'target.json');

    const result = migrateLegacyConfig({ sourcePath, targetPath });
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'no_source');
    assert.equal(fs.existsSync(targetPath), false);
  });

  it('should migrate valid legacy config, create backup, and preserve original source file', () => {
    const sourcePath = path.join(tempDir, 'legacy_config.json');
    const targetPath = path.join(tempDir, 'prod', 'config.json');
    const backupDir = path.join(tempDir, 'backups');

    const legacyData = {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'HP_OfficeJet',
    };
    fs.writeFileSync(sourcePath, JSON.stringify(legacyData, null, 2));

    const result = migrateLegacyConfig({ sourcePath, targetPath, backupDir });

    assert.equal(result.migrated, true);
    assert.equal(result.targetPath, targetPath);
    assert.ok(result.backupPath);

    // 1. Target file was created with identical data
    assert.equal(fs.existsSync(targetPath), true);
    const targetData = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.deepEqual(targetData, legacyData);

    // 2. Source file was NOT deleted (preserved per constraint)
    assert.equal(fs.existsSync(sourcePath), true);

    // 3. Backup file was created
    assert.equal(fs.existsSync(result.backupPath), true);
    const backupData = JSON.parse(fs.readFileSync(result.backupPath, 'utf8'));
    assert.deepEqual(backupData, legacyData);
  });

  it('should detect already migrated identical configuration without duplicate work', () => {
    const sourcePath = path.join(tempDir, 'legacy.json');
    const targetPath = path.join(tempDir, 'prod.json');

    const configData = {
      bwPrinter: 'Canon_GX6100',
      colorPrinter: 'Canon_GX6100',
    };
    fs.writeFileSync(sourcePath, JSON.stringify(configData));
    fs.writeFileSync(targetPath, JSON.stringify(configData));

    const result = migrateLegacyConfig({ sourcePath, targetPath });
    assert.equal(result.migrated, false);
    assert.equal(result.reason, 'already_migrated');
  });

  it('should detect conflicting configurations and STOP without overwriting destination', () => {
    const sourcePath = path.join(tempDir, 'legacy.json');
    const targetPath = path.join(tempDir, 'prod.json');

    const legacyData = {
      bwPrinter: 'Old_Printer_A',
      colorPrinter: null,
    };
    const existingProdData = {
      bwPrinter: null,
      colorPrinter: 'Canon_GX6100',
    };

    fs.writeFileSync(sourcePath, JSON.stringify(legacyData));
    fs.writeFileSync(targetPath, JSON.stringify(existingProdData));

    assert.throws(
      () => migrateLegacyConfig({ sourcePath, targetPath }),
      (err) => {
        assert.ok(err instanceof ConfigConflictError);
        assert.match(err.message, /Configuration conflict detected/);
        assert.deepEqual(err.details.sourceConfig, legacyData);
        assert.deepEqual(err.details.targetConfig, existingProdData);
        return true;
      }
    );

    // Verify destination was NOT overwritten
    const prodAfter = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    assert.deepEqual(prodAfter, existingProdData);

    // Verify source was NOT altered
    const legacyAfter = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
    assert.deepEqual(legacyAfter, legacyData);
  });
});
