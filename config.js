import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

/**
 * Standard paths for PRINTELLECT Kiosk Server configuration.
 */
export const DEFAULT_PRODUCTION_CONFIG_PATH = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'printellect', 'config.json')
  : '/var/lib/printellect/config.json';

export const LEGACY_CONFIG_PATH = path.join(process.cwd(), 'config.json');

/**
 * Custom error classes for configuration operations.
 */
export class ConfigError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ConfigError';
    this.details = details;
  }
}

export class ConfigConflictError extends ConfigError {
  constructor(message, sourceConfig, targetConfig) {
    super(message, { sourceConfig, targetConfig });
    this.name = 'ConfigConflictError';
  }
}

/**
 * Resolves the active configuration path based on environment or defaults.
 * @param {string} [customPath] - Optional explicit path to override all defaults.
 * @returns {string} Absolute path to the config file.
 */
export function getConfigPath(customPath = null) {
  if (customPath) {
    return path.resolve(customPath);
  }
  if (process.env.PRINTELLECT_CONFIG_PATH) {
    return path.resolve(process.env.PRINTELLECT_CONFIG_PATH);
  }
  return DEFAULT_PRODUCTION_CONFIG_PATH;
}

/**
 * Validates a printer configuration object against the PRINTELLECT schema.
 * Schema rules:
 * - Must be a non-null object (not an array).
 * - Only 'bwPrinter' and 'colorPrinter' keys are allowed.
 * - Values must be either null or a non-empty trimmed string.
 * - At least one of bwPrinter or colorPrinter must be a non-null string.
 * 
 * @param {any} config - Object to validate.
 * @returns {{ valid: boolean, config: object, errors: string[] }}
 */
export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      valid: false,
      config: null,
      errors: ['Configuration must be a non-null JSON object.'],
    };
  }

  const allowedKeys = new Set(['bwPrinter', 'colorPrinter']);
  const unknownKeys = Object.keys(config).filter((k) => !allowedKeys.has(k));
  if (unknownKeys.length > 0) {
    errors.push(`Unknown configuration keys detected: ${unknownKeys.join(', ')}.`);
  }

  const sanitized = {
    bwPrinter: null,
    colorPrinter: null,
  };

  // Validate bwPrinter
  if (config.bwPrinter !== undefined && config.bwPrinter !== null) {
    if (typeof config.bwPrinter !== 'string' || config.bwPrinter.trim().length === 0) {
      errors.push('bwPrinter must be a non-empty string or null.');
    } else {
      sanitized.bwPrinter = config.bwPrinter.trim();
    }
  }

  // Validate colorPrinter
  if (config.colorPrinter !== undefined && config.colorPrinter !== null) {
    if (typeof config.colorPrinter !== 'string' || config.colorPrinter.trim().length === 0) {
      errors.push('colorPrinter must be a non-empty string or null.');
    } else {
      sanitized.colorPrinter = config.colorPrinter.trim();
    }
  }

  if (!sanitized.bwPrinter && !sanitized.colorPrinter) {
    errors.push('At least one printer role (bwPrinter or colorPrinter) must be configured.');
  }

  return {
    valid: errors.length === 0,
    config: errors.length === 0 ? sanitized : null,
    errors,
  };
}

/**
 * Resolves the numeric UID and GID for the service account ('printellect') on POSIX systems.
 * Returns null on Windows or if the service user does not exist.
 *
 * @param {object} [options]
 * @param {string} [options.user='printellect']
 * @param {string} [options.group='printellect']
 * @returns {{ uid: number, gid: number, user: string, group: string } | null}
 */
export function resolveServiceIdentity({ user = 'printellect', group = 'printellect' } = {}) {
  if (process.platform === 'win32') return null;
  try {
    const userStr = execFileSync('id', ['-u', user], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    const groupStr = execFileSync('id', ['-g', group], { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    const uid = Number(userStr);
    const gid = Number(groupStr);
    if (Number.isInteger(uid) && Number.isInteger(gid)) {
      return { uid, gid, user, group };
    }
  } catch (_) {}
  return null;
}

/**
 * Enforces least-privilege POSIX permissions and ownership on configuration files.
 * Default policy:
 * - File mode: 0640 (rw-r-----): Owner read/write, Service group read, Others zero access.
 * - Parent directory mode: 0750 (rwxr-x---).
 * - Never world-readable or world-writable.
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.mode=0o640]
 * @param {object} [options.identity]
 * @returns {boolean}
 */
export function ensureSecureConfigPermissions(filePath, { mode = 0o640, identity = null } = {}) {
  if (!fs.existsSync(filePath)) return false;
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(filePath, mode);
      const targetIdentity = identity || resolveServiceIdentity();
      if (targetIdentity && process.getuid && process.getuid() === 0) {
        fs.chownSync(filePath, targetIdentity.uid, targetIdentity.gid);
      }
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Atomically writes a valid configuration to disk with secure permissions.
 * Writes to a temporary file in the same directory, syncs to physical storage,
 * enforces mode 0640 and service ownership, and atomically renames to destination.
 * 
 * @param {object} config - Configuration object to save.
 * @param {string} [targetPath] - Destination file path.
 * @param {object} [options] - Optional permission / identity overrides.
 * @returns {string} The resolved destination path.
 */
export function saveConfig(config, targetPath = null, options = {}) {
  const resolvedPath = getConfigPath(targetPath);
  const validation = validateConfig(config);

  if (!validation.valid) {
    throw new ConfigError(
      `Cannot save invalid configuration: ${validation.errors.join(' ')}`,
      validation.errors
    );
  }

  const fileMode = options.mode ?? 0o640;
  const dirMode = options.dirMode ?? 0o750;
  const identity = options.identity || resolveServiceIdentity();

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: dirMode });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dir, dirMode);
        if (identity && process.getuid && process.getuid() === 0) {
          fs.chownSync(dir, identity.uid, identity.gid);
        }
      } catch (_) {}
    }
  }

  const tempFile = path.join(
    dir,
    `.config.json.tmp.${process.pid}.${Date.now()}`
  );

  const payload = JSON.stringify(validation.config, null, 2) + '\n';

  try {
    const fd = fs.openSync(tempFile, 'w', fileMode);
    fs.writeSync(fd, payload, 0, 'utf8');
    fs.fsyncSync(fd);

    if (process.platform !== 'win32') {
      try {
        fs.fchmodSync(fd, fileMode);
        if (identity && process.getuid && process.getuid() === 0) {
          fs.fchownSync(fd, identity.uid, identity.gid);
        }
      } catch (_) {}
    }

    fs.closeSync(fd);
    fs.renameSync(tempFile, resolvedPath);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(resolvedPath, fileMode);
        if (identity && process.getuid && process.getuid() === 0) {
          fs.chownSync(resolvedPath, identity.uid, identity.gid);
        }
      } catch (_) {}
    }

    return resolvedPath;
  } catch (err) {
    if (fs.existsSync(tempFile)) {
      try {
        fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    throw new ConfigError(`Failed to atomically write configuration to ${resolvedPath}: ${err.message}`);
  }
}

/**
 * Safely migrates an existing legacy config.json to the target production path.
 * 
 * Safety invariants:
 * 1. Never deletes the source legacy file.
 * 2. Creates a timestamped backup before migration.
 * 3. Does not overwrite an existing valid destination config.
 * 4. If source and destination configs conflict, throws ConfigConflictError.
 * 5. If source and destination configs are identical, records as already migrated.
 * 
 * @param {object} [options]
 * @param {string} [options.sourcePath] - Defaults to LEGACY_CONFIG_PATH.
 * @param {string} [options.targetPath] - Defaults to DEFAULT_PRODUCTION_CONFIG_PATH.
 * @param {string} [options.backupDir] - Directory where backup is created.
 * @returns {{ migrated: boolean, reason?: string, targetPath: string, backupPath?: string }}
 */
export function migrateLegacyConfig(options = {}) {
  const sourcePath = path.resolve(options.sourcePath || LEGACY_CONFIG_PATH);
  const targetPath = path.resolve(options.targetPath || getConfigPath());
  const backupDir = options.backupDir ? path.resolve(options.backupDir) : path.dirname(sourcePath);

  if (sourcePath === targetPath) {
    return { migrated: false, reason: 'same_path', targetPath };
  }

  if (!fs.existsSync(sourcePath)) {
    return { migrated: false, reason: 'no_source', targetPath };
  }

  // Parse and validate legacy configuration
  let rawSource;
  let sourceConfig;
  try {
    rawSource = fs.readFileSync(sourcePath, 'utf8');
    sourceConfig = JSON.parse(rawSource);
  } catch (err) {
    throw new ConfigError(`Legacy configuration file at ${sourcePath} is unreadable or malformed JSON: ${err.message}`);
  }

  const sourceValidation = validateConfig(sourceConfig);
  if (!sourceValidation.valid) {
    throw new ConfigError(
      `Legacy configuration at ${sourcePath} is invalid: ${sourceValidation.errors.join(' ')}`
    );
  }

  // Check if destination configuration already exists
  if (fs.existsSync(targetPath)) {
    let targetConfig;
    try {
      const rawTarget = fs.readFileSync(targetPath, 'utf8');
      targetConfig = JSON.parse(rawTarget);
    } catch (_) {
      targetConfig = null;
    }

    const targetValidation = validateConfig(targetConfig);
    if (targetValidation.valid) {
      // Compare both configurations
      const isIdentical =
        targetValidation.config.bwPrinter === sourceValidation.config.bwPrinter &&
        targetValidation.config.colorPrinter === sourceValidation.config.colorPrinter;

      if (isIdentical) {
        return {
          migrated: false,
          reason: 'already_migrated',
          targetPath,
        };
      }

      // Conflict detected!
      throw new ConfigConflictError(
        `Configuration conflict detected between legacy file (${sourcePath}) and target file (${targetPath}). ` +
        `Target already has a different valid configuration. Migration stopped to prevent data loss.`,
        sourceValidation.config,
        targetValidation.config
      );
    }
  }

  // Create timestamped backup of the source configuration
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `config.json.bak.${timestamp}`);

  try {
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    fs.copyFileSync(sourcePath, backupPath);
  } catch (err) {
    throw new ConfigError(`Failed to create backup of legacy configuration before migration: ${err.message}`);
  }

  // Atomically write validated source config to target
  saveConfig(sourceValidation.config, targetPath);

  return {
    migrated: true,
    targetPath,
    backupPath,
    config: sourceValidation.config,
  };
}

/**
 * Loads the active configuration.
 * Resolution order:
 * 1. Explicit customPath (if provided)
 * 2. PRINTELLECT_CONFIG_PATH environment variable
 * 3. DEFAULT_PRODUCTION_CONFIG_PATH (/var/lib/printellect/config.json)
 * 4. LEGACY_CONFIG_PATH fallback (triggers safe migration if feasible)
 * 
 * @param {object} [options]
 * @param {string} [options.customPath] - Explicit path to load.
 * @param {boolean} [options.allowLegacyFallback=true] - Whether to fall back to legacy path.
 * @returns {{ config: { bwPrinter: string|null, colorPrinter: string|null }, configPath: string, isLegacy: boolean }}
 */
export function loadConfig(options = {}) {
  const customPath = options.customPath || process.env.PRINTELLECT_CONFIG_PATH;

  if (customPath) {
    const resolvedPath = path.resolve(customPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new ConfigError(`Configuration file not found at explicitly specified path: ${resolvedPath}`);
    }
    return readAndValidate(resolvedPath, false);
  }

  const productionPath = DEFAULT_PRODUCTION_CONFIG_PATH;

  // 1. Check production path
  if (fs.existsSync(productionPath)) {
    return readAndValidate(productionPath, false);
  }

  // 2. Fall back to legacy config if allowed
  const allowLegacy = options.allowLegacyFallback !== false;
  if (allowLegacy && fs.existsSync(LEGACY_CONFIG_PATH)) {
    // Attempt safe migration to production path
    try {
      const migrationResult = migrateLegacyConfig({
        sourcePath: LEGACY_CONFIG_PATH,
        targetPath: productionPath,
      });
      if (migrationResult.migrated) {
        console.warn(`[CONFIG] Migrated legacy configuration from ${LEGACY_CONFIG_PATH} to ${productionPath} (Backup: ${migrationResult.backupPath}).`);
        return {
          config: migrationResult.config,
          configPath: productionPath,
          isLegacy: false,
        };
      }
    } catch (migrationErr) {
      // If migration failed due to permissions (e.g. running as non-root dev without write access to /var/lib),
      // we log a warning and read the legacy config directly.
      if (migrationErr instanceof ConfigConflictError) {
        throw migrationErr;
      }
      console.warn(`[CONFIG WARN] Could not auto-migrate legacy config to ${productionPath}: ${migrationErr.message}. Reading directly from ${LEGACY_CONFIG_PATH}.`);
    }

    return readAndValidate(LEGACY_CONFIG_PATH, true);
  }

  throw new ConfigError(
    `No printer configuration file found at ${productionPath} or ${LEGACY_CONFIG_PATH}. ` +
    `Please run the printer setup wizard ('node setup.js' or 'printellect-setup') to configure printers.`
  );
}

function readAndValidate(filePath, isLegacy) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`Failed to read configuration file at ${filePath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Configuration file at ${filePath} contains malformed JSON: ${err.message}`);
  }

  const validation = validateConfig(parsed);
  if (!validation.valid) {
    throw new ConfigError(
      `Invalid configuration in ${filePath}: ${validation.errors.join(' ')}`,
      validation.errors
    );
  }

  return {
    config: validation.config,
    configPath: filePath,
    isLegacy,
  };
}

export default {
  DEFAULT_PRODUCTION_CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  ConfigError,
  ConfigConflictError,
  getConfigPath,
  validateConfig,
  saveConfig,
  migrateLegacyConfig,
  loadConfig,
};
