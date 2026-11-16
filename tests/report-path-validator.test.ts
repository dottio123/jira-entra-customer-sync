import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  writeReportExclusively,
  ensureNonOverwritingReportPath,
  validateAndResolveReportPath,
} from '../src/services/report-path-validator';

describe('Report Path Validator & Atomic Exclusive Persistence (Requirement 1 & 2)', () => {
  const testDir = 'reports/test-exclusive';
  const trackedFiles: string[] = [];

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    for (const file of trackedFiles) {
      if (fs.existsSync(file)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    trackedFiles.length = 0;
    if (fs.existsSync(testDir)) {
      try {
        fs.rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
  });

  describe('validateAndResolveReportPath', () => {
    it('resolves valid relative paths inside reports directory with timestamp', () => {
      const resolved = validateAndResolveReportPath('reports/my-report.json');
      expect(resolved.filePath).toMatch(/^reports[\\/]my-report-\d{4}-/);
      expect(resolved.fileName).toMatch(/^my-report-\d{4}-/);
    });

    it('rejects absolute paths', () => {
      expect(() => validateAndResolveReportPath('/etc/reports/test.json')).toThrow(
        /Absolute paths are prohibited/,
      );
      expect(() => validateAndResolveReportPath('C:/reports/test.json')).toThrow(
        /Absolute paths are prohibited/,
      );
    });

    it('rejects parent traversal components', () => {
      expect(() => validateAndResolveReportPath('reports/../secret.json')).toThrow(
        /Parent directory traversal/,
      );
    });

    it('rejects paths outside reports directory', () => {
      expect(() => validateAndResolveReportPath('output/test.json')).toThrow(
        /Reports must be stored within the 'reports' directory/,
      );
    });
  });

  describe('ensureNonOverwritingReportPath', () => {
    it('returns targetPath unchanged if file does not exist', () => {
      const nonExistent = path.join(testDir, 'does-not-exist.json');
      expect(ensureNonOverwritingReportPath(nonExistent)).toBe(nonExistent);
    });

    it('appends incrementing counter when collision occurs', () => {
      const target = path.join(testDir, 'collision-test.json');
      fs.writeFileSync(target, 'initial');
      trackedFiles.push(target);

      const next = ensureNonOverwritingReportPath(target);
      expect(next).toBe(path.join(testDir, 'collision-test-1.json'));
    });
  });

  describe('writeReportExclusively', () => {
    it('creates file exclusively with flag wx on first attempt', () => {
      const target = path.join(testDir, 'exclusive-create.json');
      trackedFiles.push(target);

      const payload = JSON.stringify({ mode: 'TEST', success: true });
      const written = writeReportExclusively(target, payload);

      expect(written).toBe(target);
      expect(fs.existsSync(target)).toBe(true);
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ mode: 'TEST', success: true });
    });

    it('preserves an existing report unchanged when collision occurs and writes to a new path', () => {
      const target = path.join(testDir, 'preserve-existing.json');
      const originalContent = JSON.stringify({ version: 1, original: true });
      fs.writeFileSync(target, originalContent, 'utf8');
      trackedFiles.push(target);

      const newContent = JSON.stringify({ version: 2, original: false });
      const writtenPath = writeReportExclusively(target, newContent);
      trackedFiles.push(writtenPath);

      // Distinct path must be used
      expect(writtenPath).not.toBe(target);
      expect(writtenPath).toBe(path.join(testDir, 'preserve-existing-1.json'));

      // Original file MUST be completely unchanged
      expect(fs.readFileSync(target, 'utf8')).toBe(originalContent);
      // New file has new content
      expect(fs.readFileSync(writtenPath, 'utf8')).toBe(newContent);
    });

    it('retries on EEXIST collision and gives two write attempts distinct paths', () => {
      const target = path.join(testDir, 'two-writers.json');

      const writer1Path = writeReportExclusively(target, JSON.stringify({ writer: 1 }));
      trackedFiles.push(writer1Path);

      const writer2Path = writeReportExclusively(target, JSON.stringify({ writer: 2 }));
      trackedFiles.push(writer2Path);

      expect(writer1Path).toBe(target);
      expect(writer2Path).toBe(path.join(testDir, 'two-writers-1.json'));

      expect(JSON.parse(fs.readFileSync(writer1Path, 'utf8'))).toEqual({ writer: 1 });
      expect(JSON.parse(fs.readFileSync(writer2Path, 'utf8'))).toEqual({ writer: 2 });
    });

    it('throws when collision retries are exhausted without altering existing files', () => {
      const target = path.join(testDir, 'exhaust.json');
      fs.writeFileSync(target, 'base');
      trackedFiles.push(target);
      const target1 = path.join(testDir, 'exhaust-1.json');
      fs.writeFileSync(target1, 'attempt1');
      trackedFiles.push(target1);
      const target2 = path.join(testDir, 'exhaust-2.json');
      fs.writeFileSync(target2, 'attempt2');
      trackedFiles.push(target2);

      expect(() => {
        writeReportExclusively(target, 'attempt3', { maxCollisionRetries: 2 });
      }).toThrow(/Exceeded maximum collision retries \(2\)/);

      // Verify all pre-existing files remained intact
      expect(fs.readFileSync(target, 'utf8')).toBe('base');
      expect(fs.readFileSync(target1, 'utf8')).toBe('attempt1');
      expect(fs.readFileSync(target2, 'utf8')).toBe('attempt2');
    });

    it('failure before exclusive creation does NOT delete an existing file', () => {
      const target = path.join(testDir, 'preexisting-safe.json');
      const safeData = JSON.stringify({ intact: true, timestamp: '2026-09-30' });
      fs.writeFileSync(target, safeData, 'utf8');
      trackedFiles.push(target);

      // Attempt write with maxCollisionRetries: 0 (immediate EEXIST collision)
      expect(() => {
        writeReportExclusively(target, 'new-data', { maxCollisionRetries: 0 });
      }).toThrow(/Exceeded maximum collision retries/);

      // Preexisting file must still exist and be completely unaltered
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(safeData);
    });

    it('removes only the current attempt incomplete file if write or serialization fails after exclusive creation, leaving pre-existing files intact', () => {
      const target = path.join(testDir, 'preexisting-base.json');
      const baseContent = JSON.stringify({ base: 'preserve-me' });
      fs.writeFileSync(target, baseContent, 'utf8');
      trackedFiles.push(target);

      const collisionTarget = path.join(testDir, 'preexisting-base-1.json');

      expect(() => {
        writeReportExclusively(target, () => {
          // Throws during payload serialization AFTER openSync('wx') succeeded for the collision target
          throw new Error('Serialization exploded');
        });
      }).toThrow('Serialization exploded');

      // Preexisting file must still exist and be intact
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe(baseContent);

      // The incomplete collision file must have been cleaned up
      expect(fs.existsSync(collisionTarget)).toBe(false);
    });

    it('an error other than EEXIST aborts immediately without collision retry and without deleting pre-existing files', () => {
      const preexisting = path.join(testDir, 'intact-before-error.json');
      const baseContent = JSON.stringify({ base: 'keep-intact' });
      fs.writeFileSync(preexisting, baseContent, 'utf8');
      trackedFiles.push(preexisting);

      // Create a regular file and use it as a directory component in the target path
      const blockingFile = path.join(testDir, 'blocking-file.txt');
      fs.writeFileSync(blockingFile, 'blocking', 'utf8');
      trackedFiles.push(blockingFile);

      const invalidPath = path.join(blockingFile, 'abort-target.json');

      expect(() => {
        writeReportExclusively(invalidPath, 'will-not-write');
      }).toThrow(/ENOENT/);

      // Pre-existing files must not have been touched
      expect(fs.existsSync(preexisting)).toBe(true);
      expect(fs.readFileSync(preexisting, 'utf8')).toBe(baseContent);
      expect(fs.existsSync(blockingFile)).toBe(true);
      expect(fs.readFileSync(blockingFile, 'utf8')).toBe('blocking');

      // No retry variant was created
      expect(fs.existsSync(path.join(blockingFile, 'abort-target-1.json'))).toBe(false);
    });

    it('final persisted artifact contains complete, valid JSON with actual report path from payload callback', () => {
      const target = path.join(testDir, 'callback-report.json');
      // Create a collision so candidatePath receives a suffix
      fs.writeFileSync(target, 'existing');
      trackedFiles.push(target);

      const written = writeReportExclusively(target, (actualPath) => {
        return JSON.stringify({
          mode: 'JIRA_FIRST_DRY_RUN',
          success: true,
          reportPath: actualPath,
        });
      });
      trackedFiles.push(written);

      expect(written).toBe(path.join(testDir, 'callback-report-1.json'));
      const parsed = JSON.parse(fs.readFileSync(written, 'utf8'));
      expect(parsed.mode).toBe('JIRA_FIRST_DRY_RUN');
      expect(parsed.success).toBe(true);
      expect(parsed.reportPath).toBe(written);
    });
  });
});
