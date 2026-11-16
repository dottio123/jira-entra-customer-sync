/**
 * Secure Atlassian OAuth Token Storage.
 *
 * ARCHITECTURAL PRINCIPLE:
 * Strictly isolated, safe persistence for OAuth 2.0 (3LO) tokens.
 * Enforces directory boundaries, forbids path traversals, prevents symlink escapes,
 * uses atomic file writes, and ensures existing records are never clobbered by partial writes.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AtlassianOAuthTokenRecord,
  AtlassianOAuthTokenRecordSchema,
  OAuthError,
  assertNoForbiddenTokenRecordFields,
} from './oauth-types';

export interface OAuthTokenStoreOptions {
  tokenPath: string;
  allowedDir?: string;
  allowCustomPath?: boolean;
}

export class OAuthTokenStore {
  private readonly resolvedPath: string;
  private readonly allowedDir: string;
  private readonly allowCustomPath: boolean;

  constructor(options: OAuthTokenStoreOptions) {
    if (!options.tokenPath || options.tokenPath.trim().length === 0) {
      throw new OAuthError(
        'OAUTH_CONFIGURATION_INVALID',
        'ATLASSIAN_OAUTH_TOKEN_PATH is required.',
      );
    }

    const rawPath = options.tokenPath.trim();

    // 1. Reject parent-path traversal
    if (rawPath.includes('..')) {
      throw new OAuthError(
        'OAUTH_STORAGE_FAILED',
        'Parent-path traversal is prohibited in token path.',
      );
    }

    this.allowCustomPath =
      options.allowCustomPath ??
      (process.env.NODE_ENV === 'test' || process.env.VITEST !== undefined);
    this.allowedDir = options.allowedDir
      ? path.resolve(options.allowedDir)
      : path.resolve(process.cwd(), 'secrets');

    // Reject unexpected absolute paths unless explicitly configured/allowed
    if (path.isAbsolute(rawPath) && !this.allowCustomPath) {
      const normalizedRaw = path.normalize(rawPath);
      if (
        !normalizedRaw.startsWith(this.allowedDir + path.sep) &&
        normalizedRaw !== this.allowedDir
      ) {
        throw new OAuthError(
          'OAUTH_STORAGE_FAILED',
          'Token path must be within the approved secrets directory.',
        );
      }
    }

    const resolved = path.isAbsolute(rawPath)
      ? path.normalize(rawPath)
      : path.resolve(process.cwd(), rawPath);

    // Verify token path stays strictly within allowedDir (unless allowCustomPath is true)
    if (!this.allowCustomPath) {
      if (!resolved.startsWith(this.allowedDir + path.sep) && resolved !== this.allowedDir) {
        throw new OAuthError(
          'OAUTH_STORAGE_FAILED',
          'Token path is outside the allowed secrets directory.',
        );
      }
    }

    // Reject an existing directory where a file is expected
    if (fs.existsSync(resolved)) {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        throw new OAuthError(
          'OAUTH_STORAGE_FAILED',
          'Token path points to an existing directory; expected a file path.',
        );
      }

      // Reject symbolic-link escapes
      const lstat = fs.lstatSync(resolved);
      if (lstat.isSymbolicLink()) {
        throw new OAuthError(
          'OAUTH_STORAGE_FAILED',
          'Symbolic links are prohibited for token storage.',
        );
      }
    }

    this.resolvedPath = resolved;
  }

  /**
   * Returns the normalized safe token path (used only for internal file operations).
   */
  getResolvedPath(): string {
    return this.resolvedPath;
  }

  /**
   * Checks whether a token record file currently exists on disk.
   */
  hasTokenRecord(): boolean {
    return fs.existsSync(this.resolvedPath);
  }

  /**
   * Reads and strictly validates the token record from storage.
   */
  readTokenRecord(): AtlassianOAuthTokenRecord {
    if (!fs.existsSync(this.resolvedPath)) {
      throw new OAuthError(
        'OAUTH_TOKEN_RECORD_MISSING',
        'OAuth token record file not found. Interactive login required (npm run oauth:login).',
      );
    }

    // Verify symlink protection on read
    const lstat = fs.lstatSync(this.resolvedPath);
    if (lstat.isSymbolicLink()) {
      throw new OAuthError(
        'OAUTH_STORAGE_FAILED',
        'Symbolic links are prohibited for token storage.',
      );
    }

    // Check excessive file size (max 64KB)
    const stat = fs.statSync(this.resolvedPath);
    if (stat.size > 64 * 1024) {
      throw new OAuthError(
        'OAUTH_TOKEN_RECORD_INVALID',
        'Token file exceeds maximum allowed size (64KB).',
      );
    }

    let fileContent: string;
    try {
      fileContent = fs.readFileSync(this.resolvedPath, { encoding: 'utf-8' });
    } catch (err) {
      throw new OAuthError(
        'OAUTH_STORAGE_FAILED',
        `Failed to read token record: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent);
    } catch {
      throw new OAuthError('OAUTH_TOKEN_RECORD_INVALID', 'Malformed JSON in token record file.');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OAuthError(
        'OAUTH_TOKEN_RECORD_INVALID',
        'Token record root must be a JSON object.',
      );
    }

    assertNoForbiddenTokenRecordFields(parsed as Record<string, unknown>);

    const validationResult = AtlassianOAuthTokenRecordSchema.safeParse(parsed);
    if (!validationResult.success) {
      const issueMsg = validationResult.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new OAuthError(
        'OAUTH_TOKEN_RECORD_INVALID',
        `Token record failed schema validation: ${issueMsg}`,
      );
    }

    return validationResult.data;
  }

  /**
   * Atomically writes a validated token record to disk.
   * Uses a temporary file in the same directory, flushes, and atomically renames.
   */
  writeTokenRecord(record: AtlassianOAuthTokenRecord): void {
    // 1. Strictly validate the record before writing
    assertNoForbiddenTokenRecordFields(record as unknown as Record<string, unknown>);
    const validated = AtlassianOAuthTokenRecordSchema.parse(record);

    const dir = path.dirname(this.resolvedPath);

    // 2. Create directory with restrictive permissions (0700) if it does not exist
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw new OAuthError(
          'OAUTH_STORAGE_FAILED',
          `Failed to create secrets directory: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 3. Reject if target path exists and is a symlink
    if (fs.existsSync(this.resolvedPath)) {
      const lstat = fs.lstatSync(this.resolvedPath);
      if (lstat.isSymbolicLink()) {
        throw new OAuthError(
          'OAUTH_STORAGE_FAILED',
          'Symbolic links are prohibited for token storage.',
        );
      }
    }

    // 4. Temporary file in same directory for atomic rename
    const tempFileName = `${path.basename(this.resolvedPath)}.${crypto.randomUUID()}.tmp`;
    const tempFilePath = path.join(dir, tempFileName);

    const payload = JSON.stringify(validated, null, 2);

    let fd: number | undefined;
    try {
      // Write temp file with restrictive permissions (0600)
      fd = fs.openSync(tempFilePath, 'w', 0o600);
      fs.writeFileSync(fd, payload, { encoding: 'utf-8' });
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;

      // Atomic rename
      fs.renameSync(tempFilePath, this.resolvedPath);
    } catch (err) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close error
        }
      }
      if (fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch {
          // ignore cleanup error
        }
      }
      throw new OAuthError(
        'OAUTH_STORAGE_FAILED',
        `Failed to persist token record atomically: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Masked inspector to prevent accidental leakage in console or logger.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[OAuthTokenStore: safe]';
  }

  toJSON(): Record<string, unknown> {
    return { type: 'OAuthTokenStore' };
  }
}
