import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { SqliteDocumentStore } from "@gitgecko/core";
import { pathwaySetupSchema, type PathwaySetup } from "./pathway-setup.js";

interface SecretEnvelope {
  readonly version: 1;
  readonly keyVersion: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface PathwaySetupRecord {
  readonly ownerId: string;
  readonly setup: PathwaySetup;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PathwayKeyRing {
  readonly currentVersion: string;
  readonly keys: ReadonlyMap<string, Uint8Array>;
}

const recordKey = (ownerId: string, setupId: string): string => `${ownerId}:${setupId}`;
const additionalData = (ownerId: string, setupId: string): Buffer => Buffer.from(`gitgecko:pathway:${ownerId}:${setupId}`, "utf8");

const encryptionKey = (keyRing: PathwayKeyRing, version: string): Buffer => {
  const key = keyRing.keys.get(version);
  if (!key || key.byteLength !== 32) throw new Error(`pathway encryption key '${version}' must contain exactly 32 bytes`);
  return Buffer.from(key);
};

const encryptSecret = (keyRing: PathwayKeyRing, ownerId: string, setupId: string, secret: string): SecretEnvelope => {
  const normalized = secret.trim();
  if (!normalized) throw new Error("pathway credential cannot be empty");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyRing, keyRing.currentVersion), iv);
  cipher.setAAD(additionalData(ownerId, setupId));
  const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  return {
    version: 1,
    keyVersion: keyRing.currentVersion,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
};

const decryptSecret = (keyRing: PathwayKeyRing, ownerId: string, setupId: string, envelope: SecretEnvelope): string => {
  if (envelope.version !== 1) throw new Error("unsupported pathway secret envelope");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(keyRing, envelope.keyVersion),
    Buffer.from(envelope.iv, "base64url"),
  );
  decipher.setAAD(additionalData(ownerId, setupId));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
};

/** Durable pathway metadata and encrypted credentials scoped to one tenant. */
export class PathwaySetupStore {
  constructor(
    private readonly store: SqliteDocumentStore,
    private readonly keyRing?: PathwayKeyRing,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (keyRing) encryptionKey(keyRing, keyRing.currentVersion);
  }

  upsert(ownerId: string, input: PathwaySetup, plaintextSecret?: string): PathwaySetupRecord {
    if (!ownerId.trim()) throw new Error("pathway owner is required");
    const setup = pathwaySetupSchema.parse(input);
    const key = recordKey(ownerId, setup.id);
    const existing = this.store.get<PathwaySetupRecord>("pathway-setups", key);
    const existingSecret = this.store.get<SecretEnvelope>("pathway-secrets", key);
    const expectsStoredSecret = setup.kind === "local" && setup.credential.kind === "stored" && setup.credential.configured;
    if (expectsStoredSecret && !plaintextSecret && !existingSecret) {
      throw new Error("configured pathway credential requires secret material");
    }
    if (plaintextSecret && (setup.kind !== "local" || setup.credential.kind !== "stored")) {
      throw new Error("secret material is only valid for a stored local-provider credential");
    }
    if ((plaintextSecret || existingSecret) && !this.keyRing) {
      throw new Error("pathway secret encryption is not configured");
    }
    const timestamp = this.now().toISOString();
    const record: PathwaySetupRecord = {
      ownerId,
      setup,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.store.transaction(() => {
      if (setup.isDefault) {
        for (const candidate of this.list(ownerId)) {
          const sameScope = candidate.setup.owner.scope === setup.owner.scope
            && (setup.owner.scope === "account"
              || (candidate.setup.owner.scope === "project" && candidate.setup.owner.projectId === setup.owner.projectId));
          if (candidate.setup.id !== setup.id && sameScope && candidate.setup.isDefault) {
            this.store.set("pathway-setups", recordKey(ownerId, candidate.setup.id), {
              ...candidate,
              setup: { ...candidate.setup, isDefault: false },
              updatedAt: timestamp,
            });
          }
        }
      }
      this.store.set("pathway-setups", key, record);
      if (plaintextSecret) this.store.set("pathway-secrets", key, encryptSecret(this.keyRing!, ownerId, setup.id, plaintextSecret));
      if (!expectsStoredSecret && existingSecret) this.store.delete("pathway-secrets", key);
    });
    return record;
  }

  list(ownerId: string): readonly PathwaySetupRecord[] {
    return this.store.list<PathwaySetupRecord>("pathway-setups")
      .filter((record) => record.ownerId === ownerId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  get(ownerId: string, setupId: string): PathwaySetupRecord | undefined {
    return this.store.get<PathwaySetupRecord>("pathway-setups", recordKey(ownerId, setupId));
  }

  /** Resolve one immutable project override or account default for a review. */
  resolveDefault(ownerId: string, projectId?: string): PathwaySetupRecord | undefined {
    const enabled = this.list(ownerId).filter((record) => record.setup.enabled && record.setup.isDefault);
    if (projectId) {
      const project = enabled.find((record) => record.setup.owner.scope === "project" && record.setup.owner.projectId === projectId);
      if (project) return project;
    }
    return enabled.find((record) => record.setup.owner.scope === "account");
  }

  resolveSecret(ownerId: string, setupId: string): string | undefined {
    const envelope = this.store.get<SecretEnvelope>("pathway-secrets", recordKey(ownerId, setupId));
    if (!envelope) return undefined;
    if (!this.keyRing) throw new Error("pathway secret encryption is not configured");
    return decryptSecret(this.keyRing, ownerId, setupId, envelope);
  }

  delete(ownerId: string, setupId: string): boolean {
    const key = recordKey(ownerId, setupId);
    const exists = Boolean(this.store.get<PathwaySetupRecord>("pathway-setups", key));
    this.store.transaction(() => {
      this.store.delete("pathway-setups", key);
      this.store.delete("pathway-secrets", key);
    });
    return exists;
  }
}

/** Parse one operator-managed base64 key without accepting passphrases. */
export const pathwayEncryptionKey = (encoded: string): Uint8Array => {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.byteLength !== 32) throw new Error("pathway encryption key must be base64 for exactly 32 bytes");
  return key;
};
