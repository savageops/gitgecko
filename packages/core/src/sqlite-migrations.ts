import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** The minimal SQLite surface required by the migration owner. */
export interface SqliteMigrationDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteMigrationStatement;
  transaction<T>(operation: () => T): () => T;
}

export interface SqliteMigrationStatement {
  run(...params: unknown[]): { readonly changes?: number };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly up: (db: SqliteMigrationDb) => void;
}

export interface SqliteMigrationOptions {
  readonly owner: string;
  readonly databasePath: string;
  readonly migrations: readonly SqliteMigration[];
  readonly now?: () => Date;
}

export interface SqliteMigrationReceipt {
  readonly owner: string;
  readonly currentVersion: number;
  readonly appliedVersions: readonly number[];
  readonly backupPath?: string;
}

const MIGRATION_TABLE = "gitgecko_schema_migrations";

const isFileBacked = (databasePath: string): boolean =>
  databasePath !== ":memory:" && !databasePath.startsWith("file:");

const validateMigrations = (migrations: readonly SqliteMigration[]): void => {
  let previous = 0;
  const seen = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1 || seen.has(migration.version)) {
      throw new Error("SQLite migration versions must be unique positive integers");
    }
    if (migration.version <= previous) throw new Error("SQLite migrations must be ordered by ascending version");
    if (!migration.name.trim()) throw new Error("SQLite migration names are required");
    seen.add(migration.version);
    previous = migration.version;
  }
};

/** Create a copy before the first pending migration changes a file-backed DB. */
const createBackup = (
  db: SqliteMigrationDb,
  owner: string,
  databasePath: string,
  version: number,
  now: () => Date,
): string | undefined => {
  if (!isFileBacked(databasePath) || !existsSync(databasePath) || statSync(databasePath).size === 0) return undefined;
  // Checkpoint WAL content before copying the database file. A failed
  // checkpoint aborts the migration rather than producing a partial backup.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const backupPath = `${databasePath}.backup-${owner}-v${version}-${now().getTime()}`;
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(databasePath, backupPath);
  return backupPath;
};

/** Apply one owner-scoped, numbered migration chain with a restore point. */
export const applySqliteMigrations = (options: SqliteMigrationOptions & { readonly db: SqliteMigrationDb }): SqliteMigrationReceipt => {
  const { db, owner, databasePath, migrations, now = () => new Date() } = options;
  if (!owner.trim()) throw new Error("SQLite migration owner is required");
  validateMigrations(migrations);

  const metadataExists = Boolean(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get<{ name: string }>(MIGRATION_TABLE));
  let backupPath: string | undefined;
  const ensureBackup = (version: number): void => {
    if (backupPath !== undefined) return;
    backupPath = createBackup(db, owner, databasePath, version, now);
  };

  if (!metadataExists) ensureBackup(migrations[0]?.version ?? 1);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
      owner TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (owner, version)
    );
    CREATE INDEX IF NOT EXISTS idx_${MIGRATION_TABLE}_owner
      ON ${MIGRATION_TABLE}(owner, version);
  `);

  const applied = new Set(db.prepare(
    `SELECT version FROM ${MIGRATION_TABLE} WHERE owner = ? ORDER BY version`,
  ).all<{ version: number }>(owner).map((row) => row.version));
  const pending = migrations.filter((migration) => !applied.has(migration.version));
  if (pending.length > 0) {
    ensureBackup(pending[0]!.version);
    db.transaction(() => {
      for (const migration of pending) {
        migration.up(db);
        db.prepare(`
          INSERT INTO ${MIGRATION_TABLE} (owner, version, name, applied_at)
          VALUES (?, ?, ?, ?)
        `).run(owner, migration.version, migration.name, now().toISOString());
      }
    })();
  }

  const currentVersion = pending.at(-1)?.version
    ?? migrations.filter((migration) => applied.has(migration.version)).at(-1)?.version
    ?? 0;
  return {
    owner,
    currentVersion,
    appliedVersions: pending.map((migration) => migration.version),
    ...(backupPath ? { backupPath } : {}),
  };
};
