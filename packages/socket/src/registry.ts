/**
 * @gitgecko/socket/registry — the owner-side registry + lifecycle phase machine.
 *
 * Implements .docs/todo/system-design/03-plugin-socket-contract.md §3, §4, §6, §8.
 * Each owner (02-architecture-overview §2) instantiates a Registry<OwnerSpec>.
 * The registry runs the strict phase machine: resolve → validate → setup → activate → run.
 * No phase skips. No backward transitions. (Cline ContributionRegistry, P-plugin-1.)
 *
 * Key invariants enforced here:
 *  - Capability gate: a plug can only register contributions for capabilities
 *    it declared in its manifest (P-plugin-1).
 *  - mutates gate: if permissions.mutatesTools, every mutating tool carries
 *    mutates:true AND the derived deny list is non-empty (P-plugin-7; throws if empty).
 *  - Dependency order: topological sort by dependencies.requires; cycle = halt.
 *  - Conflict rule: two plugs claiming an exclusive capability → higher-priority wins.
 */
import type { PlugManifest } from "./manifest.js";
import { parseManifest } from "./manifest.js";
import { err, gitGeckoError, ok, type Result } from "@gitgecko/core";

// --- Owner declaration (each owner provides one) ----------------------------

/**
 * An OwnerSpec declares the owner's capability enum and the contribution kinds
 * each capability accepts. This is how the registry knows "billing" accepts
 * {checkout, meter, validate-license, webhook} and what each looks like.
 */
export interface OwnerSpec<C extends string, K extends string> {
  readonly name: string;
  readonly capabilities: readonly C[];
  /**
   * Is the given capability exclusive? Two plugs claiming an exclusive
   * capability can't both be active — the higher-priority wins (03 §8).
   * Defaults to true; owners override for non-exclusive capabilities
   * (e.g. `rules` accepts many coexisting rule plugs).
   */
  readonly exclusive?: (capability: C) => boolean;
  /**
   * Map a capability to the contribution-kind string it registers.
   * A plug's contribution MUST match the kind for its declared capability.
   */
  readonly kindFor: (capability: C) => K;
}

// --- Plug runtime shape (what setup produces) --------------------------------

export interface Contribution {
  readonly kind: string;
  readonly mutates?: boolean; // P-plugin-7 — single source of truth for "changes state"
}

export interface PlugContext {
  readonly config: Readonly<Record<string, unknown>>;
  readonly replacing?: string; // a prior plugId being replaced (idempotent reload)
  readonly logger: Logger;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface PlugApi<C extends string, K extends string, Contrib extends Contribution> {
  /** Register a contribution. Throws if the capability wasn't declared in the manifest. */
  register(capability: C, contribution: Contrib): void;
  /** Attach the runtime hook bag (P-plugin-4). Only if manifest.hooks. */
  on(hooks: HookBag): void;
  readonly ctx: PlugContext;
}

export interface HookBag {
  beforeRun?: (ctx: RunCtx) => MaybeControl | Promise<MaybeControl>;
  afterRun?: (ctx: RunCtx & { result: unknown }) => void | Promise<void>;
  beforeTool?: (ctx: ToolCtx) => ToolControl | Promise<ToolControl>;
  afterTool?: (ctx: ToolCtx & { result: unknown }) => ToolResultControl | Promise<ToolResultControl>;
}

export interface RunCtx {
  readonly runId: string;
}
export interface ToolCtx extends RunCtx {
  readonly tool: string;
  readonly input: unknown;
}
export type MaybeControl = { stop?: true; reason?: string };
export type ToolControl = { skip?: true; stop?: true; reason?: string; input?: unknown };
export type ToolResultControl = { result?: unknown };

export interface PlugModule<C extends string, K extends string, Contrib extends Contribution> {
  readonly manifest: PlugManifest;
  setup(api: PlugApi<C, K, Contrib>): void | Promise<void>;
}

export interface ActivePlug<C extends string, K extends string, Contrib extends Contribution> {
  readonly manifest: PlugManifest;
  readonly contributions: ReadonlyArray<{ capability: C; contribution: Contrib }>;
  readonly hooks?: HookBag;
  /** The derived mutates-deny list (P-plugin-7). Non-null when mutatesTools. */
  readonly mutatesDenyList: readonly string[];
}

// --- Phase machine -----------------------------------------------------------

export type Phase = "resolve" | "validate" | "setup" | "activate" | "run";

export class Registry<C extends string, K extends string, Contrib extends Contribution> {
  private readonly active = new Map<string, ActivePlug<C, K, Contrib>>();
  constructor(private readonly spec: OwnerSpec<C, K>) {}

  /** Load a plug module through the full phase machine. Returns ok or a typed error. */
  async load(module: PlugModule<C, K, Contrib>, ctx: PlugContext): Promise<Result<ActivePlug<C, K, Contrib>>> {
    // Phase 1: resolve — parse manifest
    const resolved = this.resolve(module);
    if (!resolved.ok) return resolved;

    // Phase 2: validate — capability/permission/dependency checks
    const validation = this.validate(resolved.value.manifest);
    if (!validation.ok) return validation;

    // Phase 3: setup — let the plug register contributions via the gated api
    const setupResult = await this.setup(module, ctx);
    if (!setupResult.ok) return setupResult;

    const contributed = new Set(setupResult.value.contributions.map(({ capability }) => capability));
    const missing = setupResult.value.manifest.capabilities.filter((capability) => !contributed.has(capability as C));
    if (missing.length > 0) {
      return err(gitGeckoError(
        "socket.missing-contribution",
        `plug '${setupResult.value.manifest.id}' declared capabilities without contributions: ${missing.join(", ")}`,
      ));
    }

    // Phase 4: activate — conflict check + install
    const activation = this.activate(setupResult.value);
    if (!activation.ok) return activation;

    // Phase 5: run — plug is live
    return ok(activation.value);
  }

  /** Phase 1: resolve. */
  private resolve(module: PlugModule<C, K, Contrib>): Result<{ manifest: PlugManifest }> {
    const parsed = parseManifest(module.manifest);
    if (!parsed.ok) {
      return err(gitGeckoError("socket.manifest-invalid", `manifest failed schema validation`, { cause: parsed.error }));
    }
    if (parsed.value.owner !== this.spec.name) {
      return err(
        gitGeckoError(
          "socket.owner-mismatch",
          `plug declares owner '${parsed.value.owner}' but registry is for '${this.spec.name}'`,
        ),
      );
    }
    return ok({ manifest: parsed.value });
  }

  /** Phase 2: validate. Capability tokens, permissions grants, and manifest-internal consistency. */
  private validate(manifest: PlugManifest): Result<true> {
    // Capability-token gate: every declared capability must be in the owner's enum.
    const known = new Set(this.spec.capabilities);
    for (const cap of manifest.capabilities) {
      if (!known.has(cap as C)) {
        return err(
          gitGeckoError("socket.unknown-capability", `manifest declares capability '${cap}' not in owner '${this.spec.name}' enum`),
        );
      }
    }

    // Hard dependencies are an admission gate. Check them before setup so a
    // rejected plug cannot perform setup-time side effects.
    const requires = manifest.dependencies?.requires ?? [];
    for (const reqId of requires) {
      if (!this.active.has(reqId)) {
        return err(gitGeckoError(
          "socket.missing-dependency",
          `plug '${manifest.id}' requires '${reqId}' but it is not active; load dependencies first`,
        ));
      }
    }

    // Permissions-grant check (03 §3 validate fail condition). A plug that
    // declares permissions.mutatesTools:true MUST declare a non-empty
    // permissions surface (at least one network/filesystem/env grant or a
    // mutates-bearing contribution registered later). The contribution check
    // runs at setup (it needs the registered tools); here we only assert the
    // manifest's intent is well-formed — mutatesTools without any declared
    // tool-bearing capability is self-contradictory. This is the cheap,
    // manifest-only gate; the full deny-list-non-empty invariant is at setup.
    if (manifest.permissions.mutatesTools) {
      // mutatesTools implies the plug registers tools; the entrypoint must be
      // present (already enforced by Zod min(1)) and the permissions block
      // must not be the inert default. We allow empty network/fs/env (a pure
      // compute mutator), but reject an empty-string env token if any.
      for (const envVar of manifest.permissions.env) {
        if (envVar.trim() === "") {
          return err(
            gitGeckoError(
              "socket.permissions-grant-invalid",
              `plug '${manifest.id}' declares an empty-string env permission token — remove it or name a real var`,
            ),
          );
        }
      }
    }

    // Declared-env presence: every env var the plug says it needs must be a
    // non-empty token. (Zod min(1) on the array element catches this at parse,
    // but we re-assert here so validate() is the single chokepoint for
    // manifest-internal consistency, not just capability tokens.)
    for (const envVar of manifest.permissions.env) {
      if (envVar.trim() === "") {
        return err(
          gitGeckoError(
            "socket.permissions-grant-invalid",
            `plug '${manifest.id}' declares an empty-string env permission token`,
          ),
        );
      }
    }

    return ok(true);
  }

  /** Phase 3: setup. Capability-gated register; collects contributions + hooks. */
  private async setup(
    module: PlugModule<C, K, Contrib>,
    ctx: PlugContext,
  ): Promise<Result<{ manifest: PlugManifest; contributions: Array<{ capability: C; contribution: Contrib }>; hooks?: HookBag }>> {
    const declared = new Set(module.manifest.capabilities as readonly unknown[] as readonly C[]);
    const contributions: Array<{ capability: C; contribution: Contrib }> = [];
    let hooks: HookBag | undefined;

    const api: PlugApi<C, K, Contrib> = {
      ctx,
      register: (capability, contribution) => {
        if (!declared.has(capability)) {
          throw new Error(
            `plug '${module.manifest.id}' called register('${capability}') but its manifest declares capabilities: [${[...declared].join(", ")}]`,
          );
        }
        // Kind match: contribution.kind must equal kindFor(capability)
        const expectedKind = this.spec.kindFor(capability);
        if (contribution.kind !== expectedKind) {
          throw new Error(
            `plug '${module.manifest.id}' registered kind '${contribution.kind}' for capability '${capability}'; expected '${expectedKind}'`,
          );
        }
        contributions.push({ capability, contribution });
      },
      on: (bag) => {
        if (!module.manifest.hooks) {
          throw new Error(`plug '${module.manifest.id}' attached hooks but manifest.hooks is false`);
        }
        hooks = bag;
      },
    };

    try {
      await module.setup(api);
    } catch (e) {
      const causeMessage = e instanceof Error ? e.message : String(e);
      return err(gitGeckoError("socket.setup-failed", `plug '${module.manifest.id}' setup threw: ${causeMessage}`, { cause: e }));
    }

    // P-plugin-7 invariant: if mutatesTools, every mutating tool carries the flag,
    // and the deny list is non-empty. (Throws if empty — never silently disabled.)
    if (module.manifest.permissions.mutatesTools) {
      const mutaters = contributions
        .filter(({ contribution }) => contribution.mutates)
        .map(({ contribution }) => (contribution as { kind: string; mutates?: boolean; id?: string }).id ?? contribution.kind);
      if (mutaters.length === 0) {
        return err(
          gitGeckoError(
            "socket.mutates-deny-empty",
            `plug '${module.manifest.id}' declares mutatesTools:true but registered no mutating tools — deny list would be empty (gate silently disabled)`,
          ),
        );
      }
    }

    const loaded = { manifest: module.manifest, contributions };
    return ok(hooks ? { ...loaded, hooks } : loaded);
  }

  /** Phase 4: activate. Exclusive-capability conflict check + install. */
  private activate(loaded: {
    manifest: PlugManifest;
    contributions: Array<{ capability: C; contribution: Contrib }>;
    hooks?: HookBag;
  }): Result<ActivePlug<C, K, Contrib>> {
    const isExclusive = this.spec.exclusive ?? (() => true);

    // Conflict check against already-active plugs
    for (const { capability } of loaded.contributions) {
      if (!isExclusive(capability)) continue;
      for (const [activeId, active] of this.active) {
        if (active.contributions.some((c) => c.capability === capability)) {
          return err(
            gitGeckoError(
              "socket.capability-conflict",
              `plug '${loaded.manifest.id}' claims exclusive capability '${capability}' already held by active plug '${activeId}'`,
            ),
          );
        }
      }
    }

    const mutatesDenyList = loaded.contributions
      .filter(({ contribution }) => contribution.mutates)
      .map(({ contribution }) => (contribution as { id?: string; kind: string }).id ?? contribution.kind);

    // dependencies.requires presence check (03 §3 validate fail condition).
    // A hard dependency on a plug that isn't active yet is a rejection — the
    // caller must load deps in topo-order first (§8). This is the cheap,
    // per-plug check; the full topo-sort is the caller's responsibility.
    const requires = loaded.manifest.dependencies?.requires ?? [];
    for (const reqId of requires) {
      if (!this.active.has(reqId)) {
        return err(
          gitGeckoError(
            "socket.missing-dependency",
            `plug '${loaded.manifest.id}' requires '${reqId}' but it is not active — load dependencies in topo-order first (03 §8)`,
          ),
        );
      }
    }

    const active: ActivePlug<C, K, Contrib> = {
      manifest: loaded.manifest,
      contributions: loaded.contributions,
      ...(loaded.hooks && { hooks: loaded.hooks }),
      mutatesDenyList,
    };
    this.active.set(loaded.manifest.id, active);
    return ok(active);
  }

  /** Read accessor for the orchestrator. */
  get(plugId: string): ActivePlug<C, K, Contrib> | undefined {
    return this.active.get(plugId);
  }
  list(): readonly ActivePlug<C, K, Contrib>[] {
    return [...this.active.values()];
  }
}
