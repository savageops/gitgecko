import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  NativeThreadSchema,
  appendNativeThreadTurn,
  createFileNativeThreadStore,
  createNativeThreadRecord,
} from "./native-threads.js";

const root = (): string => mkdtempSync(join(tmpdir(), "gitgecko-thread-test-"));

const validRecord = () => createNativeThreadRecord({
  id: "thr_gitgecko_01",
  provider: "codex",
  providerThreadId: "codex-01",
  cwd: process.cwd(),
  permission: "read-only",
  now: "2026-07-17T12:00:00.000Z",
});

describe("native thread contract", () => {
  const invalidCases: readonly [string, (record: Record<string, unknown>) => void][] = [
    ["version", (record) => { record.version = 2; }],
    ["id", (record) => { record.id = "../escape"; }],
    ["provider", (record) => { record.provider = "unknown"; }],
    ["providerThreadId", (record) => { record.providerThreadId = ""; }],
    ["cwd", (record) => { record.cwd = ""; }],
    ["permission", (record) => { record.permission = "root"; }],
    ["status", (record) => { record.status = "maybe"; }],
    ["createdAt", (record) => { record.createdAt = "yesterday"; }],
    ["updatedAt", (record) => { record.updatedAt = "soon"; }],
    ["turns", (record) => { record.turns = "not-an-array"; }],
  ];

  for (const [field, mutate] of invalidCases) {
    it(`rejects an invalid ${field}`, () => {
      const candidate = structuredClone(validRecord()) as unknown as Record<string, unknown>;
      mutate(candidate);
      assert.equal(NativeThreadSchema.safeParse(candidate).success, false);
    });
  }

  it("creates a versioned active record", () => {
    const record = validRecord();
    assert.equal(record.version, 1);
    assert.equal(record.status, "active");
  });

  it("preserves the provider thread id", () => assert.equal(validRecord().providerThreadId, "codex-01"));
  it("preserves cwd", () => assert.equal(validRecord().cwd, process.cwd()));
  it("preserves permission", () => assert.equal(validRecord().permission, "read-only"));
  it("accepts Pi as a first-class review provider", () => {
    assert.equal(NativeThreadSchema.safeParse({ ...validRecord(), provider: "pi", providerThreadId: "pi-01" }).success, true);
  });
  it("starts with no turns", () => assert.deepEqual(validRecord().turns, []));

  it("appends a user turn without mutating the source", () => {
    const source = validRecord();
    const next = appendNativeThreadTurn(source, { role: "user", text: "Review this", at: "2026-07-17T12:01:00.000Z" });
    assert.equal(source.turns.length, 0);
    assert.equal(next.turns[0]?.text, "Review this");
  });

  it("appends an assistant turn", () => {
    const next = appendNativeThreadTurn(validRecord(), { role: "assistant", text: "Done", at: "2026-07-17T12:01:00.000Z" });
    assert.equal(next.turns[0]?.role, "assistant");
  });

  it("advances updatedAt from the turn timestamp", () => {
    const next = appendNativeThreadTurn(validRecord(), { role: "assistant", text: "Done", at: "2026-07-17T12:01:00.000Z" });
    assert.equal(next.updatedAt, "2026-07-17T12:01:00.000Z");
  });

  it("rejects an empty turn", () => {
    assert.throws(() => appendNativeThreadTurn(validRecord(), { role: "user", text: "", at: "2026-07-17T12:01:00.000Z" }));
  });
});

describe("file native thread store", () => {
  it("writes and reads a record", () => {
    const store = createFileNativeThreadStore(root());
    store.write(validRecord());
    assert.deepEqual(store.read("thr_gitgecko_01"), validRecord());
  });

  it("returns undefined for a missing record", () => {
    assert.equal(createFileNativeThreadStore(root()).read("thr_missing"), undefined);
  });

  it("lists records newest first", () => {
    const store = createFileNativeThreadStore(root());
    store.write(validRecord());
    store.write({ ...validRecord(), id: "thr_gitgecko_02", updatedAt: "2026-07-17T13:00:00.000Z" });
    assert.deepEqual(store.list().map((record) => record.id), ["thr_gitgecko_02", "thr_gitgecko_01"]);
  });

  it("overwrites one record atomically", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    store.write({ ...validRecord(), status: "completed" });
    assert.equal(store.read("thr_gitgecko_01")?.status, "completed");
    assert.equal(store.list().length, 1);
  });

  it("leaves no temporary file after writing", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    assert.equal(store.paths().filter((path) => path.endsWith(".tmp")).length, 0);
  });

  it("deletes an existing record", () => {
    const store = createFileNativeThreadStore(root());
    store.write(validRecord());
    assert.equal(store.delete("thr_gitgecko_01"), true);
    assert.equal(store.read("thr_gitgecko_01"), undefined);
  });

  it("reports false when deleting a missing record", () => {
    assert.equal(createFileNativeThreadStore(root()).delete("thr_missing"), false);
  });

  it("rejects traversal ids on read", () => {
    assert.throws(() => createFileNativeThreadStore(root()).read("../escape"), /thread id/i);
  });

  it("rejects traversal ids on delete", () => {
    assert.throws(() => createFileNativeThreadStore(root()).delete("../escape"), /thread id/i);
  });

  it("rejects a mismatched file id", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    const path = store.paths()[0]!;
    writeFileSync(path, JSON.stringify({ ...validRecord(), id: "thr_other" }));
    assert.throws(() => store.read("thr_gitgecko_01"), /does not match/i);
  });

  it("rejects corrupt JSON", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    writeFileSync(store.paths()[0]!, "{");
    assert.throws(() => store.read("thr_gitgecko_01"), /invalid/i);
  });

  it("rejects schema-invalid JSON", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    writeFileSync(store.paths()[0]!, JSON.stringify({ ...validRecord(), permission: "root" }));
    assert.throws(() => store.read("thr_gitgecko_01"), /invalid/i);
  });

  it("does not list non-json files", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    writeFileSync(join(directory, "notes.txt"), "ignore");
    assert.equal(store.list().length, 1);
  });

  it("persists plain JSON without secrets or executable state", () => {
    const directory = root();
    const store = createFileNativeThreadStore(directory);
    store.write(validRecord());
    const raw = readFileSync(store.paths()[0]!, "utf8");
    assert.match(raw, /"provider":"codex"/);
    assert.doesNotMatch(raw, /apiToken|environment|settings/u);
  });

  it("isolates records by id", () => {
    const store = createFileNativeThreadStore(root());
    store.write(validRecord());
    store.write({ ...validRecord(), id: "thr_gitgecko_02", providerThreadId: "codex-02" });
    assert.equal(store.read("thr_gitgecko_02")?.providerThreadId, "codex-02");
    assert.equal(store.read("thr_gitgecko_01")?.providerThreadId, "codex-01");
  });
});
