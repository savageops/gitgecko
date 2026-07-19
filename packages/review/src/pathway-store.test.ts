import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SqliteDocumentStore } from "@gitgecko/core";
import { PathwaySetupStore, pathwayEncryptionKey, type PathwayKeyRing } from "./pathway-store.js";

const keyA = new Uint8Array(32).fill(11);
const keyB = new Uint8Array(32).fill(22);
const keyRing = (currentVersion = "v1", keys: ReadonlyMap<string, Uint8Array> = new Map([["v1", keyA]])): PathwayKeyRing => ({ currentVersion, keys });
const setup = {
  id: "pathway_cloud_1",
  kind: "local" as const,
  topology: "cloud" as const,
  owner: { scope: "account" as const },
  enabled: true,
  isDefault: true,
  provider: { baseUrl: "https://models.example/v1", model: "review-model", protocol: "openai-responses" as const },
  credential: { kind: "stored" as const, configured: true },
};

const fixture = async (run: (path: string, documentStore: SqliteDocumentStore) => Promise<void> | void): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "gitgecko-pathways-"));
  const path = join(directory, "control.db");
  const documentStore = new SqliteDocumentStore(path);
  try { await run(path, documentStore); }
  finally { documentStore.close(); await rm(directory, { recursive: true, force: true }); }
};

describe("pathway setup store", () => {
  it("persists redacted metadata and decrypts only through the internal resolver", async () => fixture(async (path, documents) => {
    const store = new PathwaySetupStore(documents, keyRing());
    const record = store.upsert("tenant-a", setup, "secret-value");
    assert.equal(record.setup.kind, "local");
    assert.equal(JSON.stringify(store.list("tenant-a")).includes("secret-value"), false);
    assert.equal(store.resolveSecret("tenant-a", setup.id), "secret-value");
    assert.equal((await readFile(path)).includes(Buffer.from("secret-value")), false);
  }));

  it("binds ciphertext to tenant and setup identity", () => fixture((_path, documents) => {
    const store = new PathwaySetupStore(documents, keyRing());
    store.upsert("tenant-a", setup, "bound-secret");
    const envelope = documents.get<unknown>("pathway-secrets", `tenant-a:${setup.id}`);
    documents.set("pathway-secrets", `tenant-b:${setup.id}`, envelope);
    assert.throws(() => store.resolveSecret("tenant-b", setup.id));
  }));

  it("isolates tenant reads and deletes metadata with ciphertext atomically", () => fixture((_path, documents) => {
    const store = new PathwaySetupStore(documents, keyRing());
    store.upsert("tenant-a", setup, "secret-a");
    assert.equal(store.list("tenant-b").length, 0);
    assert.equal(store.delete("tenant-a", setup.id), true);
    assert.equal(store.get("tenant-a", setup.id), undefined);
    assert.equal(store.resolveSecret("tenant-a", setup.id), undefined);
  }));

  it("supports key rotation while historical keys remain available", () => fixture((_path, documents) => {
    new PathwaySetupStore(documents, keyRing()).upsert("tenant-a", setup, "old-secret");
    const rotated = new PathwaySetupStore(documents, keyRing("v2", new Map([["v1", keyA], ["v2", keyB]])));
    assert.equal(rotated.resolveSecret("tenant-a", setup.id), "old-secret");
    rotated.upsert("tenant-a", setup, "new-secret");
    assert.equal(rotated.resolveSecret("tenant-a", setup.id), "new-secret");
  }));

  it("keeps exactly one default per scope and prefers a project override", () => fixture((_path, documents) => {
    const store = new PathwaySetupStore(documents, keyRing());
    store.upsert("tenant-a", setup, "account-secret");
    store.upsert("tenant-a", { ...setup, id: "pathway_cloud_2" }, "replacement-secret");
    store.upsert("tenant-a", {
      ...setup,
      id: "pathway_project_1",
      owner: { scope: "project", projectId: "project-1" },
    }, "project-secret");
    assert.equal(store.list("tenant-a").filter((record) => record.setup.owner.scope === "account" && record.setup.isDefault).length, 1);
    assert.equal(store.resolveDefault("tenant-a")?.setup.id, "pathway_cloud_2");
    assert.equal(store.resolveDefault("tenant-a", "project-1")?.setup.id, "pathway_project_1");
  }));

  it("requires secret material for first configured write and rejects misplaced secrets", () => fixture((_path, documents) => {
    const store = new PathwaySetupStore(documents, keyRing());
    assert.throws(() => store.upsert("tenant-a", setup));
    assert.throws(() => store.upsert("tenant-a", { ...setup, kind: "hosted" as const, topology: "cloud" as const } as never, "secret"));
  }));

  it("persists metadata-only local pathways without an encryption key", () => fixture((_path, documents) => {
    const store = new PathwaySetupStore(documents);
    const record = store.upsert("local", {
      id: "pathway_native_codex",
      kind: "native",
      topology: "local",
      owner: { scope: "account" },
      enabled: true,
      isDefault: true,
      binary: "codex",
    });
    assert.equal(record.setup.kind, "native");
    assert.equal(store.resolveDefault("local")?.setup.id, "pathway_native_codex");
    assert.equal(store.resolveSecret("local", "pathway_native_codex"), undefined);
  }));

  it("rejects secret persistence when encryption is not configured", () => fixture((_path, documents) => {
    const store = new PathwaySetupStore(documents);
    assert.throws(() => store.upsert("local", setup, "secret"), /encryption is not configured/);
  }));

  it("rejects malformed operator keys", () => {
    assert.throws(() => pathwayEncryptionKey(Buffer.alloc(31).toString("base64")));
    assert.equal(pathwayEncryptionKey(Buffer.alloc(32).toString("base64")).byteLength, 32);
  });
});
