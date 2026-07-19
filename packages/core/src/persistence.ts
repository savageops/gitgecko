/**
 * @gitgecko/core/persistence — SQLite-backed persistent stores.
 *
 * Replaces in-memory stores with SQLite persistence (data survives restarts).
 * Uses better-sqlite3 (synchronous, fast, no native build issues with pnpm
 * onlyBuiltDependencies allowlist). Salvages continue's SQLite FTS5 pattern
 * (P-codeintel-7) for the lexical index + Continue's LanceDB+SQLite dual
 * store pattern (P-codeintel-10) for embeddings.
 *
 * Two persistent stores (the FTS5 SqliteLexicalIndex is a future addition;
 * InMemoryLexicalIndex in packages/code-intel is the current implementation):
 *  - SqliteEmbedStore: vectors + content (replaces InMemoryEmbedStore)
 *  - SqliteTraceStore: per-step trace records (replaces InMemoryTraceStore)
 *
 * All implement the SAME interfaces as their in-memory counterparts —
 * interchangeable (INV-2.3). Production uses SQLite; tests can use either.
 */
import { createRequire } from "node:module";
import { applySqliteMigrations, type SqliteMigrationDb } from "./sqlite-migrations.js";
import type { EmbedRow, EmbedSearchResult, EmbedStore, EmbedTag } from "./store-types.js";
import type { TraceRecord, RunTrace, TraceContribution } from "./store-types.js";

const require = createRequire(import.meta.url);

// --- SQLite types (avoiding direct import of better-sqlite3 for type portability) ---
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  transaction<T>(operation: () => T): SqliteTransaction<T>;
  close(): void;
}
interface SqliteTransaction<T> {
  (): T;
  immediate(): T;
}
interface SqliteStmt {
  run(...params: unknown[]): { changes: number };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

/** A small durable document store for control-plane state owned by higher layers. */
export class SqliteDocumentStore {
  private db: SqliteDb;

  constructor(dbPath: string = ":memory:") {
    const DatabaseClass = require("better-sqlite3");
    this.db = new DatabaseClass(dbPath) as SqliteDb;
    this.db.exec("PRAGMA busy_timeout = 5000;");
    applySqliteMigrations({
      db: this.db,
      owner: "control",
      databasePath: dbPath,
      migrations: [{
        version: 1,
        name: "control-documents",
        up: (db) => db.exec(`
          CREATE TABLE IF NOT EXISTS control_documents (
            namespace TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (namespace, key)
          );
          CREATE INDEX IF NOT EXISTS idx_control_documents_namespace
            ON control_documents(namespace);
        `),
      }],
    });
  }

  /** Persist one JSON-safe document under a namespaced key. */
  set<T>(namespace: string, key: string, value: T): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO control_documents (namespace, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(namespace, key, JSON.stringify(value), new Date().toISOString());
  }

  /** Atomically claim a namespaced key without replacing an existing owner. */
  setIfAbsent<T>(namespace: string, key: string, value: T): boolean {
    return this.db.prepare(`
      INSERT OR IGNORE INTO control_documents (namespace, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(namespace, key, JSON.stringify(value), new Date().toISOString()).changes > 0;
  }

  /** Read one document, returning undefined when the key has never been written. */
  get<T>(namespace: string, key: string): T | undefined {
    const row = this.db.prepare(`
      SELECT value FROM control_documents WHERE namespace = ? AND key = ?
    `).get<{ value: string }>(namespace, key);
    return row ? JSON.parse(row.value) as T : undefined;
  }

  /** Read every document in a namespace in stable key order. */
  list<T>(namespace: string): readonly T[] {
    return this.db.prepare(`
      SELECT value FROM control_documents WHERE namespace = ? ORDER BY key
    `).all<{ value: string }>(namespace).map((row) => JSON.parse(row.value) as T);
  }

  /** Delete one document and report whether it existed. */
  delete(namespace: string, key: string): boolean {
    return this.db.prepare(`
      DELETE FROM control_documents WHERE namespace = ? AND key = ?
    `).run(namespace, key).changes > 0;
  }

  /**
   * Execute a bounded group of document reads and writes atomically.
   *
   * Why: quota reservations and lifecycle transitions span more than one
   * document. Exposing the database transaction without exposing SQL keeps
   * those policies in their domain owner while preserving one durable commit.
   */
  transaction<T>(operation: () => T): T {
    return this.db.transaction(operation).immediate();
  }

  /** Release this store's SQLite connection. */
  close(): void { this.db.close(); }
}

// ============================================================================
// SqliteEmbedStore — persistent vector storage (replaces InMemoryEmbedStore)
// ============================================================================

export class SqliteEmbedStore implements EmbedStore {
  private db: SqliteDb;

  constructor(dbPath: string = ":memory:") {
    // Synchronous init (better-sqlite3 is sync)
    // For async contexts, construct in an init() call
    this.db = this.openSync(dbPath);
  }

  private openSync(dbPath: string): SqliteDb {
    // We can't use async import in constructor. Use require.
    const DatabaseClass = require("better-sqlite3");
    const db = new DatabaseClass(dbPath) as SqliteDb;
    applySqliteMigrations({
      db: db as unknown as SqliteMigrationDb,
      owner: "embed",
      databasePath: dbPath,
      migrations: [{
        version: 1,
        name: "embed-rows",
        up: (migrationDb) => migrationDb.exec(`
          CREATE TABLE IF NOT EXISTS embed_rows (
            uuid TEXT PRIMARY KEY,
            repo TEXT NOT NULL,
            branch TEXT NOT NULL,
            embedding_id TEXT NOT NULL,
            path TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            vector TEXT NOT NULL,
            content TEXT NOT NULL,
            start_line INTEGER NOT NULL,
            end_line INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_embed_tag ON embed_rows(repo, branch, embedding_id);
        `),
      }],
    });
    return db;
  }

  private tagKey(tag: EmbedTag): string {
    return `${tag.repo}|${tag.branch}|${tag.embeddingId}`;
  }

  async upsert(tag: EmbedTag, rows: readonly EmbedRow[]): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO embed_rows (uuid, repo, branch, embedding_id, path, cache_key, vector, content, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      stmt.run(row.uuid, tag.repo, tag.branch, tag.embeddingId, row.path, row.cacheKey, JSON.stringify(row.vector), row.content, row.startLine, row.endLine);
    }
  }

  async retrieve(tag: EmbedTag, vector: readonly number[], opts: { limit: number; pathPrefix?: string }): Promise<readonly EmbedSearchResult[]> {
    let sql = `SELECT * FROM embed_rows WHERE repo = ? AND branch = ? AND embedding_id = ?`;
    const params: unknown[] = [tag.repo, tag.branch, tag.embeddingId];
    if (opts.pathPrefix) {
      sql += ` AND path LIKE ?`;
      params.push(`${opts.pathPrefix}%`);
    }
    sql += ` LIMIT ?`;
    params.push(opts.limit * 3); // over-fetch for cosine reranking

    const rows = this.db.prepare(sql).all<{
      content: string; path: string; start_line: number; end_line: number; vector: string;
    }>(...params);

    const scored = rows.map((r) => {
      const storedVec = JSON.parse(r.vector) as number[];
      const dist = cosineDistance(vector, storedVec);
      return {
        chunk: { content: r.content, startLine: r.start_line, endLine: r.end_line },
        path: r.path,
        score: dist,
      };
    });
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, opts.limit);
  }

  async clear(tag: EmbedTag): Promise<void> {
    this.db.prepare(`DELETE FROM embed_rows WHERE repo = ? AND branch = ? AND embedding_id = ?`).run(tag.repo, tag.branch, tag.embeddingId);
  }

  async count(tag: EmbedTag): Promise<number> {
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM embed_rows WHERE repo = ? AND branch = ? AND embedding_id = ?`).get<{ count: number }>(tag.repo, tag.branch, tag.embeddingId);
    return result?.count ?? 0;
  }

  close(): void { this.db.close(); }
}

const cosineDistance = (a: readonly number[], b: readonly number[]): number => {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!, bv = b[i]!;
    dot += av * bv; na += av * av; nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 2 : 1 - dot / denom;
};

// ============================================================================
// SqliteTraceStore — persistent trace records (replaces InMemoryTraceStore)
// ============================================================================

export class SqliteTraceStore implements TraceContribution {
  readonly kind = "trace-store" as const;
  readonly id = "sqlite-trace";
  private db: SqliteDb;

  constructor(dbPath: string = ":memory:") {
    const DatabaseClass = require("better-sqlite3");
    this.db = new DatabaseClass(dbPath) as SqliteDb;
    applySqliteMigrations({
      db: this.db,
      owner: "trace",
      databasePath: dbPath,
      migrations: [{
        version: 1,
        name: "trace-steps",
        up: (db) => db.exec(`
          CREATE TABLE IF NOT EXISTS trace_steps (
            run_id TEXT NOT NULL,
            step_id TEXT NOT NULL,
            ts TEXT NOT NULL,
            command TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY (run_id, step_id)
          );
          CREATE INDEX IF NOT EXISTS idx_trace_run ON trace_steps(run_id);
        `),
      }],
    });
  }

  readonly record = (step: TraceRecord): void => {
    this.db.prepare(`INSERT OR REPLACE INTO trace_steps (run_id, step_id, ts, command, data) VALUES (?, ?, ?, ?, ?)`).run(
      step.runId, step.stepId, step.ts, step.command, JSON.stringify(step),
    );
  };

  readonly read = (runId: string): RunTrace => {
    const rows = this.db.prepare(`SELECT data FROM trace_steps WHERE run_id = ? ORDER BY ts`).all<{ data: string }>(runId);
    const steps = rows.map((r) => JSON.parse(r.data) as TraceRecord);
    const totalCost = steps.reduce(
      (acc, s) => s.cost
        ? { tokensIn: acc.tokensIn + s.cost.tokensIn, tokensOut: acc.tokensOut + s.cost.tokensOut, usd: acc.usd + s.cost.usd }
        : acc,
      { tokensIn: 0, tokensOut: 0, usd: 0 },
    );
    const hasCost = steps.some((s) => s.cost);
    return { runId, steps, ...(hasCost && { totalCost }) };
  };

  readonly exportJson = (runId: string): string => JSON.stringify(this.read(runId), null, 2);

  close(): void { this.db.close(); }
}
