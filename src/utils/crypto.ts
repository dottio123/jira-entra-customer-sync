import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

/**
 * Gets or initializes an encryption key for encrypting sensitive data at rest.
 * Uses explicit key string or file, or generates a persistent key inside secretsDir.
 */
export function getOrCreateEncryptionKey(secretsDir: string, explicitKey?: string): Buffer {
  if (explicitKey && explicitKey.trim()) {
    return crypto.createHash('sha256').update(explicitKey.trim()).digest();
  }

  if (!fs.existsSync(secretsDir)) {
    fs.mkdirSync(secretsDir, { recursive: true });
  }

  const keyPath = path.join(secretsDir, 'encryption.key');
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath);
  }

  const newKey = crypto.randomBytes(32);
  if (process.platform !== 'win32') {
    fs.writeFileSync(keyPath, newKey, { mode: 0o600 });
  } else {
    fs.writeFileSync(keyPath, newKey);
  }
  return newKey;
}

/**
 * Encrypts a plaintext string into a base64-encoded payload (iv:tag:ciphertext).
 */
export function encryptAtRest(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts a base64-encoded payload (iv:tag:ciphertext) using the provided key.
 */
export function decryptAtRest(encryptedPayload: string, key: Buffer): string {
  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }
  const iv = Buffer.from(parts[0]!, 'base64');
  const tag = Buffer.from(parts[1]!, 'base64');
  const encrypted = Buffer.from(parts[2]!, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}
