import * as fs from 'fs';
import * as path from 'path';

function readPackageVersion(): string {
  try {
    // Both src/ (development) and dist/ (compiled) sit one level below package.json.
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Application version, read once from package.json. */
export const APP_VERSION = readPackageVersion();

/** User-Agent sent on outbound Jira and webhook requests. */
export const USER_AGENT = `entra-jsm-customer-sync/${APP_VERSION}`;
