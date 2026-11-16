import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { hashPassword } from './password';
import { encryptAtRest, decryptAtRest, getOrCreateEncryptionKey } from '../utils/crypto';
import {
  DEFAULT_MAX_CUSTOMERS_THRESHOLD,
  DEFAULT_MAX_FIELDS_THRESHOLD,
  DEFAULT_SCHEDULE_CRON,
  DEFAULT_SCHEDULE_TIMEZONE,
  DEFAULT_SMTP_PORT,
  OAUTH_STATE_TTL_MS,
  RETENTION_AUDIT_MS,
  RETENTION_DETAILED_MS,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
} from './defaults';

export type Role = 'admin' | 'viewer';
export type RunType = 'PREVIEW' | 'LIVE_ROLLOUT' | 'COMMISSIONING_TEST';
export type TriggerSource = 'MANUAL' | 'SCHEDULED';
export type RunStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PAUSED' | 'INTERRUPTED';

export interface RunRecord {
  id: number;
  previewRunId?: number | null;
  runType: RunType;
  triggerSource: TriggerSource;
  status: RunStatus;
  startedAt: number;
  completedAt: number | null;
  approvalDigest: string | null;
  previewDigest: string | null;
  scopeServiceDeskIds: string[];
  totalCustomersEnumerated: number;
  uniqueCustomers: number;
  matchedEntraCustomers: number;
  skippedCustomers: number;
  proposedCustomerChanges: number;
  proposedFieldChanges: number;
  appliedCustomerChanges: number;
  appliedFieldChanges: number;
  verifiedFieldChanges: number;
  failureReason: string | null;
  details?: Record<string, unknown> | null;
  createdByUserId: number | null;
}

export interface RunUpdate {
  status?: RunStatus;
  completedAt?: number | null;
  approvalDigest?: string | null;
  previewDigest?: string | null;
  totalCustomersEnumerated?: number;
  uniqueCustomers?: number;
  matchedEntraCustomers?: number;
  skippedCustomers?: number;
  proposedCustomerChanges?: number;
  proposedFieldChanges?: number;
  appliedCustomerChanges?: number;
  appliedFieldChanges?: number;
  verifiedFieldChanges?: number;
  failureReason?: string | null;
  details?: Record<string, unknown> | null;
}

const RUN_UPDATE_COLUMNS = {
  status: 'status',
  completedAt: 'completed_at',
  approvalDigest: 'approval_digest',
  previewDigest: 'preview_digest',
  totalCustomersEnumerated: 'total_customers_enumerated',
  uniqueCustomers: 'unique_customers',
  matchedEntraCustomers: 'matched_entra_customers',
  skippedCustomers: 'skipped_customers',
  proposedCustomerChanges: 'proposed_customer_changes',
  proposedFieldChanges: 'proposed_field_changes',
  appliedCustomerChanges: 'applied_customer_changes',
  appliedFieldChanges: 'applied_field_changes',
  verifiedFieldChanges: 'verified_field_changes',
  failureReason: 'failure_reason',
} as const satisfies Record<Exclude<keyof RunUpdate, 'details'>, string>;

export interface AlertRecord {
  id: number;
  createdAt: number;
  severity: 'INFO' | 'WARN' | 'ERROR';
  title: string;
  message: string;
  runId: number | null;
  acknowledged: boolean;
}

export interface SystemSettings {
  approved_email_domains: string;
  commissioning_status: 'UNCOMMISSIONED' | 'COMMISSIONED_MANUAL_ONLY' | 'COMMISSIONED_AUTOMATED';
  writes_enabled: boolean;
  automation_enabled: boolean;
  schedule_cron: string;
  schedule_timezone: string;
  max_customers_threshold: number;
  max_fields_threshold: number;
  paused: boolean;
  smtp_enabled: boolean;
  smtp_host?: string;
  smtp_port?: number;
  smtp_from?: string;
  smtp_to?: string;
  smtp_username?: string;
  /** Derived: whether an SMTP password is stored. The password itself is never exposed here. */
  smtp_password_set?: boolean;
  webhook_enabled: boolean;
  webhook_url?: string;
}

const SMTP_PASSWORD_KEY = 'smtp_password';
/** Settings whose values must never appear in the audit log. */
const REDACTED_SETTING_KEYS = new Set(['webhook_url', SMTP_PASSWORD_KEY]);
/** Read-only settings computed from other storage; never written through updateSettings. */
const DERIVED_SETTING_KEYS = new Set(['smtp_password_set']);

export interface Principal {
  id: number;
  username: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface UserRecord extends Principal {
  passwordHash: string;
}

export interface SessionRecord {
  principal: Principal;
  tokenHash: string;
  csrfToken: string;
}

interface SessionRow {
  token_hash: string;
  csrf_token: string;
  expires_at: number;
  last_seen_at: number;
  id: number;
  username: string;
  role: Role;
  must_change_password: number;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    return error.code === 'EPERM';
  }
}

export class WebStore {
  readonly db: Database.Database;
  private readonly encryptionKey: Buffer;

  constructor(
    filePath: string,
    private readonly now: () => number = Date.now,
    encryptionKey?: Buffer,
    secretsDir?: string,
  ) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    if (filePath !== ':memory:' && process.platform !== 'win32') {
      fs.chmodSync(path.dirname(filePath), 0o700);
    }
    this.db = new Database(filePath);
    if (filePath !== ':memory:' && process.platform !== 'win32') {
      fs.chmodSync(filePath, 0o600);
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    if (filePath !== ':memory:' && process.platform !== 'win32') {
      for (const sidecar of [`${filePath}-wal`, `${filePath}-shm`]) {
        if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
      }
    }
    this.encryptionKey =
      encryptionKey ??
      (filePath === ':memory:'
        ? randomBytes(32)
        : getOrCreateEncryptionKey(
            secretsDir ?? path.join(path.dirname(filePath), '..', 'secrets'),
          ));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        must_change_password INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_states (
        state_hash TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL,
        actor_user_id INTEGER REFERENCES users(id),
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_type TEXT NOT NULL CHECK (run_type IN ('PREVIEW', 'LIVE_ROLLOUT', 'COMMISSIONING_TEST')),
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('MANUAL', 'SCHEDULED')),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED', 'INTERRUPTED')),
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        approval_digest TEXT,
        preview_digest TEXT,
        preview_run_id INTEGER REFERENCES runs(id),
        scope_service_desk_ids TEXT NOT NULL,
        total_customers_enumerated INTEGER NOT NULL DEFAULT 0,
        unique_customers INTEGER NOT NULL DEFAULT 0,
        matched_entra_customers INTEGER NOT NULL DEFAULT 0,
        skipped_customers INTEGER NOT NULL DEFAULT 0,
        proposed_customer_changes INTEGER NOT NULL DEFAULT 0,
        proposed_field_changes INTEGER NOT NULL DEFAULT 0,
        applied_customer_changes INTEGER NOT NULL DEFAULT 0,
        applied_field_changes INTEGER NOT NULL DEFAULT 0,
        verified_field_changes INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        details_encrypted TEXT,
        created_by_user_id INTEGER REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by_user_id INTEGER REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS active_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        locked_at INTEGER NOT NULL,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        lock_holder TEXT NOT NULL,
        pid INTEGER
      );
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        run_id INTEGER REFERENCES runs(id),
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
      CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    `);
    this.migrate();
    this.recoverInterruptedRuns();
    this.initDefaultSettings();
  }

  /**
   * Applies idempotent schema migrations in order and records the resulting version.
   * Databases created before versioning are detected column-by-column, so each step is safe to rerun.
   */
  private migrate(): void {
    const migrations: Array<() => void> = [
      // 1: lock owner PID for crash recovery, and preview linkage for rollouts.
      () => {
        this.addColumnIfMissing('active_lock', 'pid', 'INTEGER');
        this.addColumnIfMissing('runs', 'preview_run_id', 'INTEGER REFERENCES runs(id)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_runs_preview_id ON runs(preview_run_id)');
      },
    ];
    const row = this.db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
      version: number | null;
    };
    const current = row.version ?? 0;
    if (current >= migrations.length) return;
    this.db.transaction(() => {
      for (let version = current + 1; version <= migrations.length; version++) {
        migrations[version - 1]!();
      }
      this.db.prepare('DELETE FROM schema_version').run();
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migrations.length);
    })();
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  bootstrapAdmin(username: string, password: string | undefined): void {
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (count.count > 0) return;
    if (!password) {
      throw new Error(
        'ADMIN_INITIAL_PASSWORD_FILE or ADMIN_INITIAL_PASSWORD is required on first start.',
      );
    }
    this.db
      .prepare(
        `INSERT INTO users (username, password_hash, role, must_change_password, created_at)
         VALUES (?, ?, 'admin', 1, ?)`,
      )
      .run(username, hashPassword(password), this.now());
  }

  getUserByUsername(username: string): UserRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT id, username, password_hash, role, must_change_password FROM users WHERE username = ?',
      )
      .get(username) as
      | {
          id: number;
          username: string;
          password_hash: string;
          role: Role;
          must_change_password: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      role: row.role,
      mustChangePassword: Boolean(row.must_change_password),
    };
  }

  getUserById(id: number): UserRecord | undefined {
    const row = this.db.prepare('SELECT username FROM users WHERE id = ?').get(id) as
      { username: string } | undefined;
    return row ? this.getUserByUsername(row.username) : undefined;
  }

  changePassword(id: number, password: string): void {
    const passwordHash = hashPassword(password);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?')
        .run(passwordHash, id);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    })();
  }

  /** Rewrites a verified password with the current hash format without touching sessions. */
  rehashPassword(id: number, password: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(hashPassword(password), id);
  }

  createSession(userId: number): { token: string; csrfToken: string } {
    const token = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const at = this.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at);
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.hash(token), userId, csrfToken, at, at, at + SESSION_ABSOLUTE_TTL_MS);
    return { token, csrfToken };
  }

  getSession(token: string | undefined): SessionRecord | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const row = this.db
      .prepare(
        `SELECT s.token_hash, s.csrf_token, s.expires_at, s.last_seen_at,
                u.id, u.username, u.role, u.must_change_password
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
      )
      .get(this.hash(token)) as SessionRow | undefined;
    if (!row) return undefined;
    const at = this.now();
    if (row.expires_at <= at || row.last_seen_at + SESSION_IDLE_TTL_MS <= at) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return undefined;
    }
    this.db
      .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
      .run(at, row.token_hash);
    return {
      principal: {
        id: row.id,
        username: row.username,
        role: row.role,
        mustChangePassword: Boolean(row.must_change_password),
      },
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
    };
  }

  deleteSession(token: string | undefined): void {
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(this.hash(token));
    }
  }

  createOAuthState(state: string, sessionHash: string): void {
    this.db.transaction(() => {
      // Only the newest authorization attempt may complete.
      this.db.prepare('DELETE FROM oauth_states').run();
      this.db
        .prepare('INSERT INTO oauth_states (state_hash, session_hash, expires_at) VALUES (?, ?, ?)')
        .run(this.hash(state), sessionHash, this.now() + OAUTH_STATE_TTL_MS);
    })();
  }

  consumeOAuthState(state: string, sessionHash: string): boolean {
    if (!/^[a-f0-9]{64}$/.test(state)) return false;
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT session_hash, expires_at FROM oauth_states WHERE state_hash = ?')
        .get(this.hash(state)) as { session_hash: string; expires_at: number } | undefined;
      if (!row || row.session_hash !== sessionHash || row.expires_at <= this.now()) return false;
      this.db.prepare('DELETE FROM oauth_states WHERE state_hash = ?').run(this.hash(state));
      return true;
    })();
  }

  audit(actorUserId: number | null, eventType: string, outcome: string): void {
    this.db
      .prepare(
        'INSERT INTO audit_events (at, actor_user_id, event_type, outcome) VALUES (?, ?, ?, ?)',
      )
      .run(this.now(), actorUserId, eventType, outcome);
  }

  recoverInterruptedRuns(): void {
    const at = this.now();
    this.db.transaction(() => {
      const active = this.db
        .prepare('SELECT run_id, locked_at, lock_holder, pid FROM active_lock WHERE id = 1')
        .get() as
        { run_id: number; locked_at: number; lock_holder: string; pid?: number | null } | undefined;

      if (active) {
        if (active.pid && active.pid !== process.pid && isProcessRunning(active.pid)) {
          // Another living process holds the lock; do not clear lock or touch this run.
          this.db
            .prepare(
              `UPDATE runs SET status = 'INTERRUPTED', completed_at = ?, failure_reason = 'RUN_INTERRUPTED_BY_RESTART'
               WHERE status IN ('PENDING', 'RUNNING') AND id != ?`,
            )
            .run(at, active.run_id);
          return;
        }
      }

      this.db
        .prepare(
          `UPDATE runs SET status = 'INTERRUPTED', completed_at = ?, failure_reason = 'RUN_INTERRUPTED_BY_RESTART'
           WHERE status IN ('PENDING', 'RUNNING')`,
        )
        .run(at);
      this.db.prepare('DELETE FROM active_lock').run();
    })();
  }

  initDefaultSettings(): void {
    const defaults: Record<string, string> = {
      approved_email_domains: '',
      commissioning_status: 'UNCOMMISSIONED',
      writes_enabled: 'false',
      automation_enabled: 'false',
      schedule_cron: DEFAULT_SCHEDULE_CRON,
      schedule_timezone: DEFAULT_SCHEDULE_TIMEZONE,
      max_customers_threshold: String(DEFAULT_MAX_CUSTOMERS_THRESHOLD),
      max_fields_threshold: String(DEFAULT_MAX_FIELDS_THRESHOLD),
      paused: 'false',
      smtp_enabled: 'false',
      smtp_host: '',
      smtp_port: String(DEFAULT_SMTP_PORT),
      smtp_from: '',
      smtp_to: '',
      smtp_username: '',
      webhook_enabled: 'false',
      webhook_url: '',
    };

    // INSERT OR IGNORE: existing installations keep every value they have already saved.
    const insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO system_settings (key, value, updated_at, updated_by_user_id) VALUES (?, ?, ?, NULL)',
    );
    this.db.transaction(() => {
      for (const [key, val] of Object.entries(defaults)) {
        insertStmt.run(key, val, this.now());
      }
    })();
  }

  getSettings(): SystemSettings {
    const rows = this.db.prepare('SELECT key, value FROM system_settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = new Map<string, string>();
    for (const r of rows) map.set(r.key, r.value);

    return {
      commissioning_status: (map.get('commissioning_status') ?? 'UNCOMMISSIONED') as
        'UNCOMMISSIONED' | 'COMMISSIONED_MANUAL_ONLY' | 'COMMISSIONED_AUTOMATED',
      approved_email_domains: map.get('approved_email_domains') ?? '',
      writes_enabled: map.get('writes_enabled') === 'true',
      automation_enabled: map.get('automation_enabled') === 'true',
      schedule_cron: map.get('schedule_cron') || DEFAULT_SCHEDULE_CRON,
      schedule_timezone: map.get('schedule_timezone') || DEFAULT_SCHEDULE_TIMEZONE,
      max_customers_threshold: Number(
        map.get('max_customers_threshold') ?? DEFAULT_MAX_CUSTOMERS_THRESHOLD,
      ),
      max_fields_threshold: Number(map.get('max_fields_threshold') ?? DEFAULT_MAX_FIELDS_THRESHOLD),
      paused: map.get('paused') === 'true',
      smtp_enabled: map.get('smtp_enabled') === 'true',
      smtp_host: map.get('smtp_host') || undefined,
      smtp_port: map.get('smtp_port') ? Number(map.get('smtp_port')) : undefined,
      smtp_from: map.get('smtp_from') || undefined,
      smtp_to: map.get('smtp_to') || undefined,
      smtp_username: map.get('smtp_username') || undefined,
      smtp_password_set: Boolean(map.get(SMTP_PASSWORD_KEY)),
      webhook_enabled: map.get('webhook_enabled') === 'true',
      webhook_url: map.get('webhook_url') || undefined,
    };
  }

  /**
   * Writes one setting and audits the change. Unchanged values are not rewritten or audited,
   * and sensitive values (webhook URLs, credentials) are never written to the audit log.
   */
  updateSetting(key: string, value: string, actorUserId: number | null): void {
    const existing = this.db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (existing?.value === value) return;
    this.db
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at, updated_by_user_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id`,
      )
      .run(key, value, this.now(), actorUserId);
    const audited = REDACTED_SETTING_KEYS.has(key) ? `${key}=<redacted>` : `${key}=${value}`;
    this.audit(actorUserId, 'SETTING_UPDATED', audited);
  }

  updateSettings(settings: Partial<SystemSettings>, actorUserId: number | null): void {
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        if (value !== undefined && !DERIVED_SETTING_KEYS.has(key)) {
          this.updateSetting(key, String(value), actorUserId);
        }
      }
    })();
  }

  /** Stores the SMTP password encrypted at rest. An empty value clears it. */
  setSmtpPassword(password: string, actorUserId: number | null): void {
    const value = password ? encryptAtRest(password, this.encryptionKey) : '';
    this.updateSetting(SMTP_PASSWORD_KEY, value, actorUserId);
  }

  /** Returns the decrypted SMTP password, or undefined when none is stored or it cannot be read. */
  getSmtpPassword(): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get(SMTP_PASSWORD_KEY) as { value: string } | undefined;
    if (!row?.value) return undefined;
    try {
      return decryptAtRest(row.value, this.encryptionKey);
    } catch {
      return undefined;
    }
  }

  acquireRunLock(runId: number, lockHolder: string): boolean {
    const at = this.now();
    const currentPid = process.pid;
    return this.db.transaction(() => {
      const active = this.db
        .prepare('SELECT run_id, locked_at, lock_holder, pid FROM active_lock WHERE id = 1')
        .get() as
        { run_id: number; locked_at: number; lock_holder: string; pid?: number | null } | undefined;
      if (active) {
        if (active.pid && active.pid !== currentPid && isProcessRunning(active.pid)) {
          return false;
        }
        if (active.pid && !isProcessRunning(active.pid)) {
          this.db.prepare('DELETE FROM active_lock WHERE id = 1').run();
          this.db
            .prepare(
              `UPDATE runs SET status = 'INTERRUPTED', completed_at = ?, failure_reason = 'RUN_INTERRUPTED_BY_CRASH'
               WHERE id = ? AND status IN ('PENDING', 'RUNNING')`,
            )
            .run(at, active.run_id);
        } else {
          return false;
        }
      }
      this.db
        .prepare(
          'INSERT INTO active_lock (id, locked_at, run_id, lock_holder, pid) VALUES (1, ?, ?, ?, ?)',
        )
        .run(at, runId, lockHolder, currentPid);
      return true;
    })();
  }

  releaseRunLock(runId: number): void {
    this.db.prepare('DELETE FROM active_lock WHERE run_id = ?').run(runId);
  }

  getActiveLock(): { lockedAt: number; runId: number; lockHolder: string } | undefined {
    const row = this.db
      .prepare('SELECT locked_at, run_id, lock_holder FROM active_lock WHERE id = 1')
      .get() as { locked_at: number; run_id: number; lock_holder: string } | undefined;
    if (!row) return undefined;
    return { lockedAt: row.locked_at, runId: row.run_id, lockHolder: row.lock_holder };
  }

  createRun(options: {
    runType: RunType;
    triggerSource: TriggerSource;
    scopeServiceDeskIds: string[];
    createdByUserId?: number | null;
    approvalDigest?: string | null;
    previewRunId?: number | null;
  }): number {
    const at = this.now();
    const result = this.db
      .prepare(
        `INSERT INTO runs (
          run_type, trigger_source, status, started_at, scope_service_desk_ids,
          created_by_user_id, approval_digest, preview_run_id
        ) VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
      )
      .run(
        options.runType,
        options.triggerSource,
        at,
        JSON.stringify(options.scopeServiceDeskIds),
        options.createdByUserId ?? null,
        options.approvalDigest ?? null,
        options.previewRunId ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  updateRun(id: number, updates: RunUpdate): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, column] of Object.entries(RUN_UPDATE_COLUMNS) as Array<
      [keyof typeof RUN_UPDATE_COLUMNS, string]
    >) {
      const value = updates[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (updates.details !== undefined) {
      sets.push('details_encrypted = ?');
      values.push(
        updates.details ? encryptAtRest(JSON.stringify(updates.details), this.encryptionKey) : null,
      );
    }

    if (sets.length === 0) return;
    values.push(id);
    // Column names come only from the fixed RUN_UPDATE_COLUMNS map, never from input.
    this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getRun(id: number, decryptDetails = false): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRunRow(row, decryptDetails);
  }

  listRuns(limit = 20): RunRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.mapRunRow(r, false));
  }

  getLatestCompletedPreview(): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE run_type = 'PREVIEW' AND status = 'COMPLETED' ORDER BY started_at DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRunRow(row, true);
  }

  findRunByPreviewIdAndType(
    previewRunId: number,
    runType: RunType,
    excludeRunId?: number,
  ): RunRecord | undefined {
    let query =
      "SELECT * FROM runs WHERE preview_run_id = ? AND run_type = ? AND status IN ('COMPLETED', 'RUNNING')";
    const params: unknown[] = [previewRunId, runType];
    if (excludeRunId !== undefined) {
      query += ' AND id != ?';
      params.push(excludeRunId);
    }
    query += ' ORDER BY started_at DESC LIMIT 1';
    const row = this.db.prepare(query).get(...params) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRunRow(row, false);
  }

  /** True when at least one manual update completed and verified at least one field in Jira. */
  hasSuccessfulManualRollout(): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM runs WHERE run_type = 'LIVE_ROLLOUT' AND trigger_source = 'MANUAL' AND status = 'COMPLETED' AND verified_field_changes > 0 LIMIT 1",
      )
      .get();
    return Boolean(row);
  }

  getLatestScheduledRun(): RunRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM runs WHERE trigger_source = 'SCHEDULED' AND run_type != 'COMMISSIONING_TEST' ORDER BY started_at DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapRunRow(row, false);
  }

  createAlert(
    severity: 'INFO' | 'WARN' | 'ERROR',
    title: string,
    message: string,
    runId?: number | null,
  ): number {
    const at = this.now();
    const result = this.db
      .prepare(
        'INSERT INTO alerts (created_at, severity, title, message, run_id, acknowledged) VALUES (?, ?, ?, ?, ?, 0)',
      )
      .run(at, severity, title, message, runId ?? null);
    return Number(result.lastInsertRowid);
  }

  listAlerts(limit = 20, unacknowledgedOnly = false): AlertRecord[] {
    let query = 'SELECT * FROM alerts';
    const params: unknown[] = [];
    if (unacknowledgedOnly) {
      query += ' WHERE acknowledged = 0';
    }
    query += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(query).all(...params) as Array<{
      id: number;
      created_at: number;
      severity: 'INFO' | 'WARN' | 'ERROR';
      title: string;
      message: string;
      run_id: number | null;
      acknowledged: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      severity: r.severity,
      title: r.title,
      message: r.message,
      runId: r.run_id,
      acknowledged: Boolean(r.acknowledged),
    }));
  }

  acknowledgeAlert(id: number): void {
    this.db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
  }

  /**
   * Removes detailed run payloads past the detailed-retention window, audit events and
   * acknowledged alerts past the audit window, and expired sessions and OAuth states.
   * Run summaries are kept indefinitely.
   */
  pruneRetention(
    retentionDetailedMs = RETENTION_DETAILED_MS,
    retentionAuditMs = RETENTION_AUDIT_MS,
  ): { prunedRuns: number; prunedAudit: number } {
    const at = this.now();
    const runThreshold = at - retentionDetailedMs;
    const auditThreshold = at - retentionAuditMs;

    return this.db.transaction(() => {
      const runsResult = this.db
        .prepare(
          'UPDATE runs SET details_encrypted = NULL WHERE completed_at IS NOT NULL AND completed_at < ? AND details_encrypted IS NOT NULL',
        )
        .run(runThreshold);
      const auditResult = this.db
        .prepare('DELETE FROM audit_events WHERE at < ?')
        .run(auditThreshold);
      this.db
        .prepare('DELETE FROM alerts WHERE acknowledged = 1 AND created_at < ?')
        .run(auditThreshold);
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(at);
      this.db.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').run(at);
      return { prunedRuns: runsResult.changes, prunedAudit: auditResult.changes };
    })();
  }

  private mapRunRow(row: Record<string, unknown>, decryptDetails: boolean): RunRecord {
    let details: Record<string, unknown> | null = null;
    if (decryptDetails && typeof row.details_encrypted === 'string') {
      try {
        const decrypted = decryptAtRest(row.details_encrypted, this.encryptionKey);
        details = JSON.parse(decrypted);
      } catch {
        details = null;
      }
    }

    let scope: string[] = [];
    try {
      scope = JSON.parse(String(row.scope_service_desk_ids));
    } catch {
      scope = [];
    }

    return {
      id: Number(row.id),
      previewRunId: row.preview_run_id != null ? Number(row.preview_run_id) : null,
      runType: row.run_type as RunType,
      triggerSource: row.trigger_source as TriggerSource,
      status: row.status as RunStatus,
      startedAt: Number(row.started_at),
      completedAt: row.completed_at != null ? Number(row.completed_at) : null,
      approvalDigest: row.approval_digest ? String(row.approval_digest) : null,
      previewDigest: row.preview_digest ? String(row.preview_digest) : null,
      scopeServiceDeskIds: scope,
      totalCustomersEnumerated: Number(row.total_customers_enumerated ?? 0),
      uniqueCustomers: Number(row.unique_customers ?? 0),
      matchedEntraCustomers: Number(row.matched_entra_customers ?? 0),
      skippedCustomers: Number(row.skipped_customers ?? 0),
      proposedCustomerChanges: Number(row.proposed_customer_changes ?? 0),
      proposedFieldChanges: Number(row.proposed_field_changes ?? 0),
      appliedCustomerChanges: Number(row.applied_customer_changes ?? 0),
      appliedFieldChanges: Number(row.applied_field_changes ?? 0),
      verifiedFieldChanges: Number(row.verified_field_changes ?? 0),
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      details,
      createdByUserId: row.created_by_user_id != null ? Number(row.created_by_user_id) : null,
    };
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
