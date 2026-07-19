import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applySqliteMigrations } from "./sqlite-migrations.js";

const makeDbPath = (name: string): string => join(tmpdir(), `gitgecko-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
const cleanup = (path: string): void => {
  for (const candidate of readdirSync(tmpdir()).filter((entry) => entry.startsWith(path.split("\\").at(-1)!.replace(/\.db$/, "")))) {
    try { unlinkSync(join(tmpdir(), candidate)); } catch { /* test cleanup is best effort */ }
  }
};

describe("SQLite migration owner", () => {
  it("records an owner-scoped version and reads it after a cold start", () => {
    const path = makeDbPath("cold-start");
    const first = new Database(path);
    const firstReceipt = applySqliteMigrations({
      db: first as never,
      owner: "test-owner",
      databasePath: path,
      migrations: [{ version: 1, name: "seed", up: (db) => db.exec("CREATE TABLE test_rows (id TEXT PRIMARY KEY);") }],
    });
    first.prepare("INSERT INTO test_rows (id) VALUES (?)").run("row-1");
    first.close();

    const second = new Database(path);
    const secondReceipt = applySqliteMigrations({
      db: second as never,
      owner: "test-owner",
      databasePath: path,
      migrations: [{ version: 1, name: "seed", up: (db) => db.exec("CREATE TABLE test_rows (id TEXT PRIMARY KEY);") }],
    });
    assert.equal(firstReceipt.currentVersion, 1);
    assert.equal(secondReceipt.currentVersion, 1);
    assert.deepEqual(second.prepare("SELECT id FROM test_rows").all(), [{ id: "row-1" }]);
    assert.deepEqual(second.prepare("SELECT version, name FROM gitgecko_schema_migrations WHERE owner = ?").all("test-owner"), [{ version: 1, name: "seed" }]);
    second.close();
    cleanup(path);
  });

  it("creates a pre-migration backup and rolls back a failed version", () => {
    const path = makeDbPath("rollback");
    const seed = new Database(path);
    seed.exec("CREATE TABLE existing_rows (id TEXT PRIMARY KEY); INSERT INTO existing_rows VALUES ('keep');");
    seed.close();

    const db = new Database(path);
    assert.throws(() => applySqliteMigrations({
      db: db as never,
      owner: "test-owner",
      databasePath: path,
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      migrations: [{
        version: 1,
        name: "failed-change",
        up: (migrationDb) => {
          migrationDb.exec("CREATE TABLE transient_rows (id TEXT PRIMARY KEY);");
          throw new Error("migration failed");
        },
      }],
    }), /migration failed/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("transient_rows"), undefined);
    assert.deepEqual(db.prepare("SELECT id FROM existing_rows").all(), [{ id: "keep" }]);
    db.close();
    assert.equal(existsSync(`${path}.backup-test-owner-v1-1783814400000`), true);
    cleanup(path);
  });
});
