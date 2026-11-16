import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;
const PRODUCTION_COST = 16384;
/** Reduced cost keeps the automated test suite fast; never used outside NODE_ENV=test. */
const TEST_COST = 1024;
const SUPPORTED_COSTS = new Set([TEST_COST, PRODUCTION_COST]);

function currentCost(): number {
  return process.env.NODE_ENV === 'test' ? TEST_COST : PRODUCTION_COST;
}

/** Cost used by hashes written before the cost was stored in the hash itself. */
function legacyCost(): number {
  return process.env.NODE_ENV === 'production' ? PRODUCTION_COST : TEST_COST;
}

/** Encodes as `scrypt$<cost>$<salt>$<hash>` so verification never depends on the environment. */
export function hashPassword(password: string): string {
  if (password.length < 12 || password.length > 1024) {
    throw new Error('Password must contain between 12 and 1024 characters.');
  }
  const cost = currentCost();
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, KEY_LENGTH, { cost, maxmem: MAX_MEMORY }).toString('hex');
  return `scrypt$${cost}$${salt}$${hash}`;
}

function parseHash(encoded: string): { cost: number; salt: string; hash: string } | undefined {
  const parts = encoded.split('$');
  if (parts[0] !== 'scrypt') return undefined;
  let cost: number;
  let salt: string | undefined;
  let hash: string | undefined;
  if (parts.length === 4) {
    cost = Number(parts[1]);
    if (!SUPPORTED_COSTS.has(cost)) return undefined;
    [salt, hash] = [parts[2], parts[3]];
  } else if (parts.length === 3) {
    cost = legacyCost();
    [salt, hash] = [parts[1], parts[2]];
  } else {
    return undefined;
  }
  if (!/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(hash ?? '')) return undefined;
  return { cost, salt: salt!, hash: hash! };
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (password.length > 1024 || !parsed) return false;
  const candidate = scryptSync(password, parsed.salt, KEY_LENGTH, {
    cost: parsed.cost,
    maxmem: MAX_MEMORY,
  });
  return timingSafeEqual(candidate, Buffer.from(parsed.hash, 'hex'));
}

/** True when a stored hash uses the legacy format or a weaker cost and should be rewritten. */
export function passwordNeedsRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  return !parsed || encoded.split('$').length !== 4 || parsed.cost !== currentCost();
}
