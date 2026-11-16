import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encryptAtRest, decryptAtRest, getOrCreateEncryptionKey } from '../src/utils/crypto';

describe('crypto utils', () => {
  it('encrypts and decrypts strings correctly with AES-256-GCM', () => {
    const key = Buffer.alloc(32, 7);
    const plaintext = 'sensitive-customer-email@example.com';
    const encrypted = encryptAtRest(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');

    const decrypted = decryptAtRest(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('fails decryption with altered ciphertext or wrong key', () => {
    const key1 = Buffer.alloc(32, 1);
    const key2 = Buffer.alloc(32, 2);
    const encrypted = encryptAtRest('top-secret', key1);

    expect(() => decryptAtRest(encrypted, key2)).toThrow();

    const parts = encrypted.split(':');
    const tampered = `${parts[0]}:${parts[1]}:dGFtcGVyZWQ=`;
    expect(() => decryptAtRest(tampered, key1)).toThrow();
  });

  it('generates and persists an encryption key in secretsDir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-test-'));
    try {
      const secretsDir = path.join(tmp, 'secrets');
      const key1 = getOrCreateEncryptionKey(secretsDir);
      expect(key1.length).toBe(32);
      expect(fs.existsSync(path.join(secretsDir, 'encryption.key'))).toBe(true);

      const key2 = getOrCreateEncryptionKey(secretsDir);
      expect(key2.equals(key1)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
