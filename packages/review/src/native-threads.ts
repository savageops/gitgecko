/**
 * GitGecko-owned native-agent thread records.
 *
 * Provider CLIs own their private session history. This owner persists only the
 * normalized handle and transcript GitGecko needs to resume threads it created.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const NativeAgentProviderSchema = z.enum(["codex", "claude", "opencode", "pi"]);
export type NativeAgentProvider = z.infer<typeof NativeAgentProviderSchema>;

export const NativeAgentPermissionSchema = z.enum(["read-only", "workspace-write", "unrestricted"]);
export type NativeAgentPermission = z.infer<typeof NativeAgentPermissionSchema>;

export const NativeThreadTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  at: z.iso.datetime(),
});
export type NativeThreadTurn = z.infer<typeof NativeThreadTurnSchema>;

export const NativeThreadSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^thr_[A-Za-z0-9_-]{3,120}$/u),
  provider: NativeAgentProviderSchema,
  providerThreadId: z.string().min(1),
  cwd: z.string().min(1),
  permission: NativeAgentPermissionSchema,
  status: z.enum(["active", "completed", "failed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  turns: z.array(NativeThreadTurnSchema),
});
export type NativeThread = z.infer<typeof NativeThreadSchema>;

export interface CreateNativeThreadInput {
  readonly id: string;
  readonly provider: NativeAgentProvider;
  readonly providerThreadId: string;
  readonly cwd: string;
  readonly permission: NativeAgentPermission;
  readonly now?: string;
}

/** Create the normalized owner record after a provider starts a session. */
export const createNativeThreadRecord = (input: CreateNativeThreadInput): NativeThread => {
  const now = input.now ?? new Date().toISOString();
  return NativeThreadSchema.parse({
    version: 1,
    id: input.id,
    provider: input.provider,
    providerThreadId: input.providerThreadId,
    cwd: input.cwd,
    permission: input.permission,
    status: "active",
    createdAt: now,
    updatedAt: now,
    turns: [],
  });
};

/** Append one normalized turn without mutating the caller's record. */
export const appendNativeThreadTurn = (thread: NativeThread, turn: NativeThreadTurn): NativeThread => {
  const parsedTurn = NativeThreadTurnSchema.parse(turn);
  return NativeThreadSchema.parse({
    ...thread,
    updatedAt: parsedTurn.at,
    turns: [...thread.turns, parsedTurn],
  });
};

export interface NativeThreadStore {
  readonly read: (id: string) => NativeThread | undefined;
  readonly list: () => readonly NativeThread[];
  readonly write: (thread: NativeThread) => void;
  readonly delete: (id: string) => boolean;
  /** Exposed for diagnostics and isolated customer-path verification. */
  readonly paths: () => readonly string[];
}

const assertThreadId = (id: string): void => {
  if (!/^thr_[A-Za-z0-9_-]{3,120}$/u.test(id)) {
    throw new Error(`Invalid native thread id '${id}'.`);
  }
};

/** Create the atomic one-record-per-file thread store. */
export const createFileNativeThreadStore = (directory: string): NativeThreadStore => {
  const ensureDirectory = (): void => { mkdirSync(directory, { recursive: true }); };
  const pathFor = (id: string): string => {
    assertThreadId(id);
    return join(directory, `${id}.json`);
  };

  const read = (id: string): NativeThread | undefined => {
    const path = pathFor(id);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = NativeThreadSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.id !== id) throw new Error(`Native thread file id '${parsed.id}' does not match '${id}'.`);
      return parsed;
    } catch (error) {
      if (error instanceof Error && /does not match/u.test(error.message)) throw error;
      throw new Error(`Native thread '${id}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const paths = (): readonly string[] => {
    ensureDirectory();
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(directory, entry.name));
  };

  return {
    read,
    paths,
    list: () => paths()
      .map((path) => readFileSync(path, "utf8"))
      .map((raw, index) => {
        try {
          return NativeThreadSchema.parse(JSON.parse(raw));
        } catch (error) {
          throw new Error(`Native thread file '${paths()[index] ?? "unknown"}' is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    write: (thread) => {
      const parsed = NativeThreadSchema.parse(thread);
      ensureDirectory();
      const target = pathFor(parsed.id);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(parsed), { encoding: "utf8", mode: 0o600 });
        renameSync(temporary, target);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    },
    delete: (id) => {
      const path = pathFor(id);
      if (!existsSync(path)) return false;
      unlinkSync(path);
      return true;
    },
  };
};
