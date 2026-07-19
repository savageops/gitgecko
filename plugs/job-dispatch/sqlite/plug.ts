/**
 * SQLite review-work dispatcher. Webhook receipt and worker execution are
 * separate transactions so an acknowledged GitHub delivery is never lost.
 */
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { applySqliteMigrations, type SqliteMigrationDb } from "@gitgecko/core";
import { parseManifest, type PlugApi, type PlugManifest, type PlugModule } from "@gitgecko/socket";
import {
  DEFAULT_RETRY_POLICY,
  JobDispatchError,
  type EnqueueReviewInput,
  type EnqueueReviewResult,
  type EnqueueIndexInput,
  type EnqueueIndexResult,
  type IndexWorkItem,
  type IndexWorkPayload,
  type JobDispatchCapability,
  type JobDispatchContribution,
  type JobDispatchContributionKind,
  type ReviewWorkItem,
  type ReviewWorkPayload,
  type RetryPolicy,
  type RenewIndexInput,
  type RedriveWorkInput,
} from "@gitgecko/job-dispatch";
import manifestJson from "./plug.manifest.json" with { type: "json" };

const parsed = parseManifest(manifestJson);
if (!parsed.ok) throw new Error(`job-dispatch SQLite manifest invalid: ${JSON.stringify(parsed.error.issues)}`);
export const manifest: PlugManifest = parsed.value;

export interface SqliteJobDispatchOptions {
  readonly databasePath: string;
  readonly retryPolicy?: RetryPolicy;
}

type JobRow = {
  work_id: string; idempotency_key: string; payload: string; state: ReviewWorkItem["state"];
  attempts: number; max_attempts: number; available_at: string; created_at: string; updated_at: string;
  lease_owner: string | null; lease_expires_at: string | null; completed_at: string | null;
  dead_lettered_at: string | null; last_error: string | null;
};

type WorkItem = ReviewWorkItem | IndexWorkItem;
type WorkPayload = ReviewWorkPayload | IndexWorkPayload;
type WorkTable = "review_work_items" | "index_work_items";
type WorkInput = { readonly idempotencyKey: string; readonly payload: WorkPayload; readonly now?: Date };

const iso = (now: Date): string => now.toISOString();
const parseReviewPayload = (value: string): ReviewWorkPayload => {
  const payload = JSON.parse(value) as ReviewWorkPayload & { tenantId?: string };
  return payload.tenantId ? payload : { ...payload, tenantId: "legacy:unresolved" };
};
const reviewPayloadKey = (payload: ReviewWorkPayload): string => {
  return JSON.stringify([
    payload.tenantId,
    payload.ownerId,
    payload.projectId,
    payload.deliveryId,
    payload.installationId,
    payload.repositoryId,
    payload.pullNumber,
  ]);
};
const asWork = (row: JobRow): ReviewWorkItem => ({
  kind: "review", workId: row.work_id, idempotencyKey: row.idempotency_key,
  payload: parseReviewPayload(row.payload), state: row.state, attempts: row.attempts,
  maxAttempts: row.max_attempts, availableAt: row.available_at, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
  ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
  ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  ...(row.dead_lettered_at ? { deadLetteredAt: row.dead_lettered_at } : {}),
  ...(row.last_error ? { lastError: row.last_error } : {}),
});

const parseIndexPayload = (value: string): IndexWorkPayload => {
  const payload = JSON.parse(value) as IndexWorkPayload & { tenantId?: string };
  return payload.tenantId ? payload : { ...payload, tenantId: "legacy:unresolved" };
};
const asIndexWork = (row: JobRow): IndexWorkItem => ({
  ...asWork(row),
  kind: "index",
  payload: parseIndexPayload(row.payload),
});

const validatePayload = (payload: ReviewWorkPayload): void => {
  if (!payload.tenantId || payload.tenantId.length > 200 || /[\u0000-\u001f]/u.test(payload.tenantId)
    || !payload.ownerId || !payload.projectId || !payload.deliveryId || !payload.installationId || !payload.repositoryId
    || !Number.isSafeInteger(payload.pullNumber) || payload.pullNumber < 1) {
    throw new JobDispatchError("invalid_input", "review work requires tenant, delivery, repository, and a valid pull number");
  }
};

const validateIndexPayload = (payload: IndexWorkPayload): void => {
  if (!payload.tenantId || payload.tenantId.length > 200 || /[\u0000-\u001f]/u.test(payload.tenantId)
    || !payload.ownerId || !payload.projectId || !payload.deliveryId || !payload.installationId
    || !payload.repositoryId || !payload.ref || !payload.commitSha) {
    throw new JobDispatchError("invalid_input", "index work requires tenant, delivery, repository, ref, and commit SHA");
  }
};

/**
 * A process-safe SQLite store. All state transitions are fenced by lease owner
 * and expiry. This follows the Kodus inbox/outbox enqueue boundary documented
 * in .refs/01-pr-review/kodus-ai-main/apps/webhooks/src/modules/webhook-enqueue.module.ts:7-37.
 */
export class SqliteJobDispatchStore {
  readonly #db: Database.Database;
  readonly #retry: RetryPolicy;

  constructor(options: SqliteJobDispatchOptions) {
    this.#db = new Database(options.databasePath);
    this.#retry = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
    if (!Number.isSafeInteger(this.#retry.maxAttempts) || this.#retry.maxAttempts < 1 || this.#retry.baseDelayMs < 1 || this.#retry.maxDelayMs < this.#retry.baseDelayMs) {
      throw new JobDispatchError("invalid_input", "retry policy is invalid");
    }
    applySqliteMigrations({
      db: this.#db as unknown as SqliteMigrationDb,
      owner: "job-dispatch",
      databasePath: options.databasePath,
      migrations: [{
        version: 1,
        name: "review-and-index-work-items",
        up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS review_work_items (
          work_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, available_at TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, completed_at TEXT,
          dead_lettered_at TEXT, last_error TEXT
        ); CREATE INDEX IF NOT EXISTS review_work_ready ON review_work_items(state, available_at);
        CREATE TABLE IF NOT EXISTS index_work_items (
          work_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL,
          attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, available_at TEXT NOT NULL, created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, completed_at TEXT,
          dead_lettered_at TEXT, last_error TEXT
        ); CREATE INDEX IF NOT EXISTS index_work_ready ON index_work_items(state, available_at);`),
      }, {
        version: 2,
        name: "dead-letter-review-work-without-tenant",
        up: (db) => db.exec(`UPDATE review_work_items
          SET state='dead-letter', lease_owner=NULL, lease_expires_at=NULL,
              dead_lettered_at=COALESCE(dead_lettered_at, updated_at),
              last_error='legacy review work has no authoritative tenant; reconnect the repository'
          WHERE (json_type(payload, '$.tenantId') IS NULL OR trim(json_extract(payload, '$.tenantId'))='')
            AND state IN ('queued', 'leased', 'retry_wait');`),
      }, {
        version: 3,
        name: "dead-letter-index-work-without-tenant",
        up: (db) => db.exec(`UPDATE index_work_items
          SET state='dead-letter', lease_owner=NULL, lease_expires_at=NULL,
              dead_lettered_at=COALESCE(dead_lettered_at, updated_at),
              last_error='legacy index work has no authoritative tenant; reconnect the repository'
          WHERE (json_type(payload, '$.tenantId') IS NULL OR trim(json_extract(payload, '$.tenantId'))='')
            AND state IN ('queued', 'leased', 'retry_wait');`),
      }],
    });
  }

  close(): void { this.#db.close(); }
  getReview(workId: string): ReviewWorkItem | undefined {
    const row = this.#db.prepare("SELECT * FROM review_work_items WHERE work_id = ?").get(workId) as JobRow | undefined;
    return row ? asWork(row) : undefined;
  }

  findReviewByIdempotencyKey(idempotencyKey: string): ReviewWorkItem | undefined {
    if (!idempotencyKey) throw new JobDispatchError("invalid_input", "idempotency key is required");
    const row = this.#db.prepare("SELECT * FROM review_work_items WHERE idempotency_key = ?").get(idempotencyKey) as JobRow | undefined;
    return row ? asWork(row) : undefined;
  }

  getIndex(workId: string): IndexWorkItem | undefined {
    const row = this.#getRow("index_work_items", workId);
    return row ? asIndexWork(row) : undefined;
  }

  enqueueIndex(input: EnqueueIndexInput): EnqueueIndexResult {
    validateIndexPayload(input.payload);
    const result = this.#enqueue("index_work_items", "index-work", input, asIndexWork);
    return result;
  }

  leaseIndex(input: { readonly workerId: string; readonly leaseDurationMs: number; readonly now?: Date }): IndexWorkItem | undefined {
    return this.#lease("index_work_items", input, asIndexWork);
  }

  renewIndex(input: RenewIndexInput): IndexWorkItem {
    if (!input.workerId || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new JobDispatchError("invalid_input", "worker id and positive lease duration are required");
    }
    const now = input.now ?? new Date();
    const expiry = new Date(now.getTime() + input.leaseDurationMs);
    const changed = this.#db.prepare("UPDATE index_work_items SET lease_expires_at=?, updated_at=? WHERE work_id=? AND state='leased' AND lease_owner=? AND lease_expires_at > ?").run(
      iso(expiry), iso(now), input.workId, input.workerId, iso(now),
    );
    if (changed.changes !== 1) throw new JobDispatchError("lease_conflict", "only an unexpired lease owner can renew index work");
    return this.getIndex(input.workId)!;
  }

  completeIndex(input: { readonly workId: string; readonly workerId: string; readonly now?: Date }): IndexWorkItem {
    return this.#complete("index_work_items", "index", input, asIndexWork);
  }

  retryIndex(input: { readonly workId: string; readonly workerId: string; readonly error: string; readonly terminal?: boolean; readonly now?: Date }): { item: IndexWorkItem; deadLettered: boolean; retryAt?: string } {
    return this.#retryWork("index_work_items", "index", input, asIndexWork);
  }

  redriveIndex(input: RedriveWorkInput): IndexWorkItem {
    const now = input.now ?? new Date();
    const changed = this.#db.prepare("UPDATE index_work_items SET state='queued', attempts=0, available_at=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL, dead_lettered_at=NULL, last_error=NULL WHERE work_id=? AND state='dead-letter'").run(iso(now), iso(now), input.workId);
    if (changed.changes !== 1) {
      if (!this.getIndex(input.workId)) throw new JobDispatchError("not_found", "index work was not found");
      throw new JobDispatchError("invalid_transition", "only dead-letter index work can be redriven");
    }
    return this.getIndex(input.workId)!;
  }

  recoverStaleIndexLeases(input: { readonly now?: Date } = {}): readonly IndexWorkItem[] {
    const now = input.now ?? new Date();
    return this.#db.transaction(() => this.#recover("index_work_items", now, asIndexWork))();
  }

  #getRow(table: WorkTable, workId: string): JobRow | undefined {
    return this.#db.prepare(`SELECT * FROM ${table} WHERE work_id = ?`).get(workId) as JobRow | undefined;
  }

  #enqueue<T extends WorkItem>(
    table: WorkTable,
    idPrefix: string,
    input: WorkInput,
    map: (row: JobRow) => T,
  ): { readonly item: T; readonly created: boolean } {
    if (!input.idempotencyKey) throw new JobDispatchError("invalid_input", "idempotency key is required");
    const serialized = JSON.stringify(input.payload);
    const now = input.now ?? new Date();
    const existing = this.#db.prepare(`SELECT * FROM ${table} WHERE idempotency_key = ?`).get(input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      if (existing.payload !== serialized) throw new JobDispatchError("idempotency_conflict", "idempotency key belongs to different work");
      return { item: map(existing), created: false };
    }
    const workId = `${idPrefix}-${randomUUID()}`;
    try {
      this.#db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`).run(
        workId, input.idempotencyKey, serialized, this.#retry.maxAttempts, iso(now), iso(now), iso(now),
      );
    } catch {
      const raced = this.#db.prepare(`SELECT * FROM ${table} WHERE idempotency_key = ?`).get(input.idempotencyKey) as JobRow | undefined;
      if (raced && raced.payload === serialized) return { item: map(raced), created: false };
      throw new JobDispatchError("idempotency_conflict", "idempotency key belongs to different work");
    }
    return { item: map(this.#getRow(table, workId)!), created: true };
  }

  #lease<T extends WorkItem>(table: WorkTable, input: { readonly workerId: string; readonly leaseDurationMs: number; readonly now?: Date }, map: (row: JobRow) => T): T | undefined {
    if (!input.workerId || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new JobDispatchError("invalid_input", "worker id and positive lease duration are required");
    }
    const now = input.now ?? new Date();
    return this.#db.transaction(() => {
      this.#recover(table, now, map);
      const current = this.#db.prepare(`SELECT * FROM ${table} WHERE state IN ('queued', 'retry_wait') AND available_at <= ? ORDER BY created_at LIMIT 1`).get(iso(now)) as JobRow | undefined;
      if (!current) return undefined;
      const expiry = new Date(now.getTime() + input.leaseDurationMs);
      const changed = this.#db.prepare(`UPDATE ${table} SET state='leased', attempts=attempts+1, lease_owner=?, lease_expires_at=?, updated_at=? WHERE work_id=? AND state IN ('queued', 'retry_wait')`).run(input.workerId, iso(expiry), iso(now), current.work_id);
      return changed.changes === 1 ? map(this.#getRow(table, current.work_id)!) : undefined;
    })();
  }

  #complete<T extends WorkItem>(table: WorkTable, label: string, input: { readonly workId: string; readonly workerId: string; readonly now?: Date }, map: (row: JobRow) => T): T {
    const now = input.now ?? new Date();
    const existing = this.#getRow(table, input.workId);
    if (!existing) throw new JobDispatchError("not_found", `${label} work was not found`);
    if (existing.state !== "leased") throw new JobDispatchError("invalid_transition", `only leased ${label} work can complete`);
    const changed = this.#db.prepare(`UPDATE ${table} SET state='completed', lease_owner=NULL, lease_expires_at=NULL, completed_at=?, updated_at=? WHERE work_id=? AND state='leased' AND lease_owner=? AND lease_expires_at > ?`).run(iso(now), iso(now), input.workId, input.workerId, iso(now));
    if (changed.changes !== 1) throw new JobDispatchError("lease_conflict", `only an unexpired lease owner can complete ${label} work`);
    return map(this.#getRow(table, input.workId)!);
  }

  #retryWork<T extends WorkItem>(table: WorkTable, label: string, input: { readonly workId: string; readonly workerId: string; readonly error: string; readonly terminal?: boolean; readonly now?: Date }, map: (row: JobRow) => T): { item: T; deadLettered: boolean; retryAt?: string } {
    const now = input.now ?? new Date();
    return this.#db.transaction(() => {
      const current = this.#getRow(table, input.workId);
      if (!current) throw new JobDispatchError("not_found", `${label} work was not found`);
      if (current.state !== "leased") throw new JobDispatchError("invalid_transition", `only leased ${label} work can retry`);
      if (current.lease_owner !== input.workerId || !current.lease_expires_at || Date.parse(current.lease_expires_at) <= now.getTime()) {
        throw new JobDispatchError("lease_conflict", `only an unexpired lease owner can retry ${label} work`);
      }
      if (!input.error.trim()) throw new JobDispatchError("invalid_input", "retry error is required");
      const terminal = input.terminal === true || current.attempts >= current.max_attempts;
      const delay = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** Math.max(0, current.attempts - 1));
      const retryAt = new Date(now.getTime() + delay);
      this.#db.prepare(`UPDATE ${table} SET state=?, lease_owner=NULL, lease_expires_at=NULL, available_at=?, updated_at=?, dead_lettered_at=?, last_error=? WHERE work_id=?`).run(
        terminal ? "dead-letter" : "retry_wait", iso(terminal ? now : retryAt), iso(now), terminal ? iso(now) : null, input.error.slice(0, 1000), input.workId,
      );
      return { item: map(this.#getRow(table, input.workId)!), deadLettered: terminal, ...(terminal ? {} : { retryAt: iso(retryAt) }) };
    })();
  }

  #recover<T extends WorkItem>(table: WorkTable, now: Date, map: (row: JobRow) => T): readonly T[] {
    const stale = this.#db.prepare(`SELECT * FROM ${table} WHERE state='leased' AND lease_expires_at <= ?`).all(iso(now)) as JobRow[];
    return stale.map((row) => {
      const terminal = row.attempts >= row.max_attempts;
      const retryAt = new Date(now.getTime() + this.#retry.baseDelayMs);
      this.#db.prepare(`UPDATE ${table} SET state=?, lease_owner=NULL, lease_expires_at=NULL, available_at=?, updated_at=?, dead_lettered_at=?, last_error='lease expired' WHERE work_id=?`).run(
        terminal ? "dead-letter" : "retry_wait", iso(terminal ? now : retryAt), iso(now), terminal ? iso(now) : null, row.work_id,
      );
      return map(this.#getRow(table, row.work_id)!);
    });
  }

  enqueueReview(input: EnqueueReviewInput): EnqueueReviewResult {
    if (!input.idempotencyKey) throw new JobDispatchError("invalid_input", "idempotency key is required");
    validatePayload(input.payload);
    const now = input.now ?? new Date();
    const existing = this.#db.prepare("SELECT * FROM review_work_items WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
    if (existing) {
      if (reviewPayloadKey(parseReviewPayload(existing.payload)) !== reviewPayloadKey(input.payload)) throw new JobDispatchError("idempotency_conflict", "idempotency key belongs to different review work");
      return { item: asWork(existing), created: false };
    }
    const workId = `review-work-${randomUUID()}`;
    try {
      this.#db.prepare(`INSERT INTO review_work_items VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`).run(
        workId, input.idempotencyKey, JSON.stringify(input.payload), this.#retry.maxAttempts, iso(now), iso(now), iso(now),
      );
    } catch {
      const raced = this.#db.prepare("SELECT * FROM review_work_items WHERE idempotency_key = ?").get(input.idempotencyKey) as JobRow | undefined;
      if (raced && reviewPayloadKey(parseReviewPayload(raced.payload)) === reviewPayloadKey(input.payload)) return { item: asWork(raced), created: false };
      throw new JobDispatchError("idempotency_conflict", "idempotency key belongs to different review work");
    }
    return { item: this.getReview(workId)!, created: true };
  }

  leaseReview(input: { readonly workerId: string; readonly leaseDurationMs: number; readonly now?: Date }): ReviewWorkItem | undefined {
    if (!input.workerId || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new JobDispatchError("invalid_input", "worker id and positive lease duration are required");
    }
    const now = input.now ?? new Date();
    return this.#db.transaction(() => {
      this.recoverStaleLeasesAt(now);
      const current = this.#db.prepare("SELECT * FROM review_work_items WHERE state IN ('queued', 'retry_wait') AND available_at <= ? ORDER BY created_at LIMIT 1").get(iso(now)) as JobRow | undefined;
      if (!current) return undefined;
      const expiry = new Date(now.getTime() + input.leaseDurationMs);
      const changed = this.#db.prepare("UPDATE review_work_items SET state='leased', attempts=attempts+1, lease_owner=?, lease_expires_at=?, updated_at=? WHERE work_id=? AND state IN ('queued', 'retry_wait')").run(input.workerId, iso(expiry), iso(now), current.work_id);
      return changed.changes === 1 ? this.getReview(current.work_id) : undefined;
    })();
  }

  /** Extends a review lease without changing attempts or reopening completed work. */
  renewReview(input: { readonly workId: string; readonly workerId: string; readonly leaseDurationMs: number; readonly now?: Date }): ReviewWorkItem {
    if (!input.workerId || !Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1) {
      throw new JobDispatchError("invalid_input", "worker id and positive lease duration are required");
    }
    const now = input.now ?? new Date();
    const expiry = new Date(now.getTime() + input.leaseDurationMs);
    const changed = this.#db.prepare("UPDATE review_work_items SET lease_expires_at=?, updated_at=? WHERE work_id=? AND state='leased' AND lease_owner=? AND lease_expires_at > ?").run(
      iso(expiry), iso(now), input.workId, input.workerId, iso(now),
    );
    if (changed.changes !== 1) throw new JobDispatchError("lease_conflict", "only an unexpired lease owner can renew review work");
    return this.getReview(input.workId)!;
  }

  completeReview(input: { readonly workId: string; readonly workerId: string; readonly now?: Date }): ReviewWorkItem {
    const now = input.now ?? new Date();
    const existing = this.#db.prepare("SELECT * FROM review_work_items WHERE work_id = ?").get(input.workId) as JobRow | undefined;
    if (!existing) throw new JobDispatchError("not_found", "review work was not found");
    if (existing.state !== "leased") throw new JobDispatchError("invalid_transition", "only leased review work can complete");
    const changed = this.#db.prepare("UPDATE review_work_items SET state='completed', lease_owner=NULL, lease_expires_at=NULL, completed_at=?, updated_at=? WHERE work_id=? AND state='leased' AND lease_owner=? AND lease_expires_at > ?").run(iso(now), iso(now), input.workId, input.workerId, iso(now));
    if (changed.changes !== 1) throw new JobDispatchError("lease_conflict", "only an unexpired lease owner can complete review work");
    return this.getReview(input.workId)!;
  }

  retryReview(input: { readonly workId: string; readonly workerId: string; readonly error: string; readonly terminal?: boolean; readonly now?: Date }): { item: ReviewWorkItem; deadLettered: boolean; retryAt?: string } {
    const now = input.now ?? new Date();
    return this.#db.transaction(() => {
      const current = this.#db.prepare("SELECT * FROM review_work_items WHERE work_id = ?").get(input.workId) as JobRow | undefined;
      if (!current) throw new JobDispatchError("not_found", "review work was not found");
      if (current.state !== "leased") throw new JobDispatchError("invalid_transition", "only leased review work can retry");
      if (current.lease_owner !== input.workerId || !current.lease_expires_at || Date.parse(current.lease_expires_at) <= now.getTime()) {
        throw new JobDispatchError("lease_conflict", "only an unexpired lease owner can retry review work");
      }
      if (!input.error.trim()) throw new JobDispatchError("invalid_input", "retry error is required");
      const terminal = input.terminal === true || current.attempts >= current.max_attempts;
      const delay = Math.min(this.#retry.maxDelayMs, this.#retry.baseDelayMs * 2 ** Math.max(0, current.attempts - 1));
      const retryAt = new Date(now.getTime() + delay);
      this.#db.prepare("UPDATE review_work_items SET state=?, lease_owner=NULL, lease_expires_at=NULL, available_at=?, updated_at=?, dead_lettered_at=?, last_error=? WHERE work_id=?").run(
        terminal ? "dead-letter" : "retry_wait", iso(terminal ? now : retryAt), iso(now), terminal ? iso(now) : null, input.error.slice(0, 1000), input.workId,
      );
      return { item: this.getReview(input.workId)!, deadLettered: terminal, ...(terminal ? {} : { retryAt: iso(retryAt) }) };
    })();
  }

  redriveReview(input: RedriveWorkInput): ReviewWorkItem {
    const now = input.now ?? new Date();
    const changed = this.#db.prepare("UPDATE review_work_items SET state='queued', attempts=0, available_at=?, updated_at=?, lease_owner=NULL, lease_expires_at=NULL, completed_at=NULL, dead_lettered_at=NULL, last_error=NULL WHERE work_id=? AND state='dead-letter'").run(iso(now), iso(now), input.workId);
    if (changed.changes !== 1) {
      if (!this.getReview(input.workId)) throw new JobDispatchError("not_found", "review work was not found");
      throw new JobDispatchError("invalid_transition", "only dead-letter review work can be redriven");
    }
    return this.getReview(input.workId)!;
  }

  recoverStaleLeases(input: { readonly now?: Date } = {}): readonly ReviewWorkItem[] {
    const now = input.now ?? new Date();
    return this.#db.transaction(() => this.recoverStaleLeasesAt(now))();
  }

  private recoverStaleLeasesAt(now: Date): readonly ReviewWorkItem[] {
    const stale = this.#db.prepare("SELECT * FROM review_work_items WHERE state='leased' AND lease_expires_at <= ?").all(iso(now)) as JobRow[];
    return stale.map((row) => {
      const terminal = row.attempts >= row.max_attempts;
      const retryAt = new Date(now.getTime() + this.#retry.baseDelayMs);
      this.#db.prepare("UPDATE review_work_items SET state=?, lease_owner=NULL, lease_expires_at=NULL, available_at=?, updated_at=?, dead_lettered_at=?, last_error='lease expired' WHERE work_id=?").run(
        terminal ? "dead-letter" : "retry_wait", iso(terminal ? now : retryAt), iso(now), terminal ? iso(now) : null, row.work_id,
      );
      return this.getReview(row.work_id)!;
    });
  }
}

/** Creates the socket plug with one durable review-work contribution. */
export const createSqliteJobDispatchPlug = (options: SqliteJobDispatchOptions) => {
  const store = new SqliteJobDispatchStore(options);
  const contribution: JobDispatchContribution = {
    kind: "review-work", id: "job-dispatch-sqlite", mutates: true,
    enqueueReview: (input) => store.enqueueReview(input),
    leaseReview: (input) => store.leaseReview(input),
    renewReview: (input) => store.renewReview(input),
    completeReview: (input) => store.completeReview(input),
    retryReview: (input) => store.retryReview(input),
    recoverStaleLeases: (input) => store.recoverStaleLeases(input),
    getReview: (workId) => store.getReview(workId),
    findReviewByIdempotencyKey: (idempotencyKey) => store.findReviewByIdempotencyKey(idempotencyKey),
    redriveReview: (input) => store.redriveReview(input),
    enqueueIndex: (input) => store.enqueueIndex(input),
    leaseIndex: (input) => store.leaseIndex(input),
    renewIndex: (input) => store.renewIndex(input),
    completeIndex: (input) => store.completeIndex(input),
    retryIndex: (input) => store.retryIndex(input),
    recoverStaleIndexLeases: (input) => store.recoverStaleIndexLeases(input),
    getIndex: (workId) => store.getIndex(workId),
    redriveIndex: (input) => store.redriveIndex(input),
    close: () => store.close(),
  };
  return {
    manifest,
    setup: (api: PlugApi<JobDispatchCapability, JobDispatchContributionKind, JobDispatchContribution>): void => {
      api.register("review", contribution);
      api.register("index", contribution);
    },
  } satisfies PlugModule<JobDispatchCapability, JobDispatchContributionKind, JobDispatchContribution>;
};

/** Production composition uses the configured control database. */
export const setup = createSqliteJobDispatchPlug({ databasePath: process.env.GITGECKO_DB_PATH ?? ":memory:" }).setup;
