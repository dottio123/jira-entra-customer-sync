import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedReportPath {
  filePath: string;
  fileName: string;
}

export interface ExclusiveWriteOptions {
  maxCollisionRetries?: number;
}

/**
 * Writes content to a file exclusively (using flag 'wx'), ensuring no existing file is overwritten.
 * If a filename collision (EEXIST) occurs, retries with sequential numerical suffixes up to maxCollisionRetries.
 * Distinguishes collisions from permission (EACCES), disk full (ENOSPC), and other IO failures.
 * If a partial file was created during a failed write, it is cleaned up.
 */
export function writeReportExclusively(
  targetPath: string,
  content: string | ((candidatePath: string) => string),
  options: ExclusiveWriteOptions = {},
): string {
  const maxRetries = options.maxCollisionRetries ?? 10;
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ext = path.extname(targetPath) || '.json';
  const base = path.basename(targetPath, ext);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const candidatePath = attempt === 0 ? targetPath : path.join(dir, `${base}-${attempt}${ext}`);

    let fd: number | null = null;
    let ownedByThisAttempt = false;

    try {
      fd = fs.openSync(candidatePath, 'wx');
      ownedByThisAttempt = true;

      const payload = typeof content === 'function' ? content(candidatePath) : content;
      fs.writeFileSync(fd, payload, { encoding: 'utf8' });
      fs.closeSync(fd);
      fd = null;

      return candidatePath;
    } catch (err: unknown) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close failure
        }
        fd = null;
      }

      const nodeErr = err as NodeJS.ErrnoException;
      if (ownedByThisAttempt) {
        try {
          fs.unlinkSync(candidatePath);
        } catch {
          // Ignore cleanup failure
        }
      }

      if (!ownedByThisAttempt && nodeErr && nodeErr.code === 'EEXIST') {
        if (attempt === maxRetries) {
          throw new Error(
            `Failed to persist report: Exceeded maximum collision retries (${maxRetries}) attempting to exclusively create report at "${targetPath}".`,
          );
        }
        continue;
      }

      if (nodeErr && nodeErr.code === 'EACCES') {
        throw new Error(
          `Failed to persist report: Permission denied writing to "${candidatePath}".`,
        );
      }
      if (nodeErr && nodeErr.code === 'ENOSPC') {
        throw new Error(
          `Failed to persist report: No space left on device writing to "${candidatePath}".`,
        );
      }
      throw err;
    }
  }

  throw new Error(`Failed to persist report exclusively at "${targetPath}".`);
}

/**
 * Ensures that a resolved report path will not overwrite an existing report on disk.
 * If the file exists, appends an incrementing counter before the extension.
 */
export function ensureNonOverwritingReportPath(targetPath: string): string {
  if (!fs.existsSync(targetPath)) {
    return targetPath;
  }
  const dir = path.dirname(targetPath);
  const ext = path.extname(targetPath) || '.json';
  const base = path.basename(targetPath, ext);
  let counter = 1;
  while (fs.existsSync(path.join(dir, `${base}-${counter}${ext}`))) {
    counter++;
  }
  return path.join(dir, `${base}-${counter}${ext}`);
}

/**
 * Validates and resolves report file paths strictly within the 'reports' directory.
 *
 * Rules:
 * 1. Reject absolute paths.
 * 2. Reject parent directory traversal components ('..').
 * 3. Reject paths outside the 'reports' directory.
 * 4. Generate a report filename containing a UTC timestamp.
 */
export function validateAndResolveReportPath(
  configuredPath?: string,
  now: Date = new Date(),
): ResolvedReportPath {
  const reportsDir = 'reports';

  // Create UTC timestamp: e.g. 2026-09-29T19-07-10Z (Windows-safe: colons replaced with dashes)
  const timestamp = now.toISOString().replace(/:/g, '-').replace(/\..+/, '') + 'Z';

  if (!configuredPath || configuredPath.trim().length === 0) {
    const fileName = `dry-run-report-${timestamp}.json`;
    return {
      filePath: path.join(reportsDir, fileName),
      fileName,
    };
  }

  const rawPath = configuredPath.trim();

  // Reject absolute paths (POSIX and Windows drive letters/UNC)
  if (path.isAbsolute(rawPath) || /^[a-zA-Z]:[\\/]/.test(rawPath)) {
    throw new Error(
      `Invalid report path "${configuredPath}": Absolute paths are prohibited. Reports must be located within the 'reports' directory.`,
    );
  }

  // Reject parent traversal (checked before path.normalize collapses components)
  const rawSegments = rawPath.replace(/\\/g, '/').split('/');
  if (rawSegments.includes('..') || rawPath.includes('..')) {
    throw new Error(
      `Invalid report path "${configuredPath}": Parent directory traversal ('..') is prohibited.`,
    );
  }

  const normalized = path.normalize(rawPath).replace(/\\/g, '/');
  const parts = normalized.split('/').filter((p) => p.length > 0);

  // Reject paths outside reports directory
  if (parts.length === 0 || parts[0] !== reportsDir) {
    throw new Error(
      `Invalid report path "${configuredPath}": Reports must be stored within the 'reports' directory.`,
    );
  }

  // If path is just 'reports' or 'reports/'
  if (parts.length === 1) {
    const fileName = `dry-run-report-${timestamp}.json`;
    return {
      filePath: path.join(reportsDir, fileName),
      fileName,
    };
  }

  // If path includes a filename inside reports (e.g. reports/dry-run.json)
  const lastPart = parts[parts.length - 1]!;
  const ext = path.extname(lastPart) || '.json';
  const baseName = path.basename(lastPart, ext);

  // Check if filename already contains a UTC timestamp
  const hasTimestamp = /\d{4}-?\d{2}-?\d{2}[T_]\d{2}-?\d{2}-?\d{2}/i.test(baseName);
  const finalFileName = hasTimestamp ? `${baseName}${ext}` : `${baseName}-${timestamp}${ext}`;

  const subDirs = parts.slice(1, -1);
  const finalFilePath = path.join(reportsDir, ...subDirs, finalFileName);

  return {
    filePath: finalFilePath,
    fileName: finalFileName,
  };
}
