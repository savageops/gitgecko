/**
 * @gitgecko/cli/auth — the device-linking auth flow (`gitgecko login` → `~/gitgecko/auth.json`).
 *
 * THE FLOW (the normalized OAuth device-flow — GitHub CLI, Stripe CLI, Vercel CLI):
 *   1. `gitgecko login` → requestDeviceCode → prints the verification URL for the user.
 *   2. User logs in (or is already logged in → redirect to the device-accept page).
 *   3. User clicks "Authorize this device" in the platform UI.
 *   4. CLI polls (pollForToken) until authorized → receives a device token + planId.
 *   5. saveAuth writes `~/gitgecko/auth.json` → the device appears in /settings/devices.
 *
 * WHY device-flow (not a paste-a-token flow): it is what users expect from a CLI
 * in 2026 (every major CLI uses it), it requires no manual copy-paste, and it
 * naturally supports multiple linked devices (each gets its own deviceId + token).
 *
 * Local/self-host does NOT need CLI auth — the local frontend talks to local
 * services directly. Auth is a cloud-deployment concern (the platform needs to
 * know WHO you are to enforce your plan). This module is inert on local deploys.
 *
 * DESIGN (gold standard, not cheap): the HTTP client + the auth store are
 * INJECTED interfaces, so the logic is unit-testable with no real network and no
 * real filesystem. The real implementations (createRealDeviceFlowClient,
 * createFileAuthStore) are factories wired by the bin; tests inject fakes.
 *
 * Provenance (G11): the device-flow shape is the OAuth device-authorization grant
 * (RFC 8628-shaped (GitGecko endpoint, not standard OAuth)). The normalized CLI experience is harvested in UX-SYNTHESIS.md §3.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { randomBytes } from "node:crypto";
import open from "open";
import type { PlanId } from "@gitgecko/plans";
import { productIdentity, resolveProductCloudUrl } from "@gitgecko/core";

/** The response from the device-code request (RFC 8628-shaped (GitGecko endpoint, not standard OAuth) §3.1). */
export interface DeviceCodeResponse {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

/** The result of polling for the token. */
export type PollResult =
  | { readonly status: "ok"; readonly token: string; readonly planId: PlanId; readonly deviceId: string }
  | { readonly status: "expired" | "denied" }
  | { readonly status: "timeout" };

/** The persisted auth state (`~/gitgecko/auth.json`). */
export interface AuthState {
  readonly version: 2;
  readonly token: string;
  readonly deviceId: string;
  readonly cloudUrl: string;
}

interface LegacyAuthState {
  readonly token: string;
  readonly planId?: PlanId;
  readonly deviceId: string;
  readonly cloudUrl: string;
}

/**
 * The device-flow HTTP client. Injected so tests fake it; the real impl
 * (createRealDeviceFlowClient) shells out to the platform's /auth/device endpoint.
 */
export interface DeviceFlowClient {
  readonly requestDeviceCode: () => Promise<DeviceCodeResponse>;
  readonly pollForToken: (deviceCode: string) => Promise<
    { status: "ok"; token: string; planId: PlanId; deviceId: string }
    | { status: "pending" | "expired" | "denied" }
    | { status: "slow_down"; retryAfterMs?: number }
  >;
  readonly revokeToken?: (token: string, deviceId: string) => Promise<void>;
}

/** The auth.json store. Injected so tests use an in-memory fake. */
export interface AuthStore {
  readonly read: () => AuthState | undefined;
  readonly write: (state: AuthState) => void;
  readonly remove: () => void;
}

/** Request a device code (step 1 of the flow). */
export const requestDeviceCode = async (client: DeviceFlowClient): Promise<DeviceCodeResponse> =>
  client.requestDeviceCode();

/**
 * Poll for the token (step 4). Polls every intervalMs up to maxAttempts.
 * Returns "ok" with the token + planId once the user authorizes, or "timeout".
 */
export const pollForToken = async (
  client: DeviceFlowClient,
  deviceCode: string,
  opts: { readonly maxAttempts: number; readonly intervalMs: number },
): Promise<PollResult> => {
  let intervalMs = opts.intervalMs;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    const res = await client.pollForToken(deviceCode);
    if (res.status === "ok") {
      return { status: "ok", token: res.token, planId: res.planId, deviceId: res.deviceId };
    }
    if (res.status === "expired" || res.status === "denied") return { status: res.status };
    if (res.status === "slow_down") {
      // A server-provided Retry-After is authoritative. Without it, use the
      // RFC-shaped incremental backoff so a rate-limited client slows down.
      intervalMs = Math.max(res.retryAfterMs ?? intervalMs + 5_000, 0);
    }
    if (attempt < opts.maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { status: "timeout" };
};

/** Save the auth state (step 5 — writes `~/gitgecko/auth.json`). */
export const saveAuth = async (store: AuthStore, state: AuthState): Promise<void> => {
  store.write(state);
};

/** Load the auth state (returns undefined if not authenticated). */
export const loadAuth = (store: AuthStore): AuthState | undefined => store.read();

/** Remove the auth state (the injectable primitive — tests call this; the bin calls `logout()`). */
export const removeAuthState = (store: AuthStore): void => {
  store.remove();
};

/** The canonical device state path is ~/gitgecko/auth.json. */
export const getAuthFilePath = (): string => join(homedir(), productIdentity.authDirectory, "auth.json");

/** Launch the normalized browser approval flow while retaining a printable fallback for headless hosts. */
export const openDeviceApproval = async (
  url: string,
  openUrl: (target: string) => Promise<unknown> = (target) => open(target, { wait: false }),
): Promise<boolean> => {
  try {
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
};

/** Keep headless and CI auth deterministic without changing the interactive default. */
export const shouldOpenDeviceApproval = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env.GITGECKO_NO_BROWSER !== "1";

// --- Real implementations (wired by the bin; tests inject fakes) -------------

/** The cloud base URL (env-configurable for self-hosted). */
const CLOUD_URL = (): string => resolveProductCloudUrl(process.env);

/**
 * Create the real device-flow client (talks to the platform's /auth/device).
 * Used by the bin in production; tests inject a fake instead.
 */
export const createRealDeviceFlowClient = (
  cloudUrl: string = CLOUD_URL(),
  request: typeof fetch = fetch,
): DeviceFlowClient => ({
  requestDeviceCode: async () => {
    const res = await request(`${cloudUrl}/auth/device`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: "gitgecko-cli", hostname: hostname() }),
    });
    if (!res.ok) throw new Error(`Cloud auth endpoint returned ${res.status}. Set GITGECKO_CLOUD_URL or check your network.`);
    return (await res.json()) as DeviceCodeResponse;
  },
  pollForToken: async (deviceCode: string) => {
    const res = await request(`${cloudUrl}/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    if (res.status === 200) {
      const data = (await res.json()) as { token: string; planId: PlanId; deviceId: string };
      return { status: "ok" as const, token: data.token, planId: data.planId, deviceId: data.deviceId };
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      return {
        status: "slow_down" as const,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
      };
    }
    if (res.status === 400) {
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (data.error === "authorization_pending") return { status: "pending" as const };
      if (data.error === "expired_token") return { status: "expired" as const };
      if (data.error === "access_denied") return { status: "denied" as const };
      if (data.error === "slow_down") return { status: "slow_down" as const, retryAfterMs: 15_000 };
      throw new Error(`Cloud auth endpoint rejected device polling (${data.error ?? "unknown error"}).`);
    }
    throw new Error(`Cloud auth endpoint returned ${res.status} while polling. Retry login after checking service status.`);
  },
  revokeToken: async (token, deviceId) => {
    const res = await request(`${cloudUrl}/auth/device?deviceId=${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Cloud logout returned ${res.status}.`);
  },
});

/**
 * Create the real file-backed auth store (reads/writes `~/gitgecko/auth.json`).
 * Used by the bin in production; tests inject a fake instead.
 */
/** Replace auth state atomically so interruption cannot leave a partial bearer token. */
const writeAuthFile = (authFile: string, state: AuthState): void => {
  const directory = join(authFile, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${authFile}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temporary, authFile);
    chmodSync(authFile, 0o600);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
};

export const createFileAuthStore = (authFile: string = getAuthFilePath()): AuthStore => ({
  read: () => {
    const sourceFile = existsSync(authFile) ? authFile : undefined;
    if (!sourceFile) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(sourceFile, "utf-8")) as Partial<AuthState & LegacyAuthState>;
      if (parsed.version !== undefined && parsed.version !== 2) return undefined;
      if (typeof parsed.token !== "string" || typeof parsed.deviceId !== "string" || typeof parsed.cloudUrl !== "string") {
        return undefined;
      }
      const state: AuthState = {
        version: 2,
        token: parsed.token,
        deviceId: parsed.deviceId,
        cloudUrl: parsed.cloudUrl,
      };
      if (parsed.version === undefined) writeAuthFile(authFile, state);
      return state;
    } catch {
      return undefined;
    }
  },
  write: (state: AuthState) => {
    writeAuthFile(authFile, state);
  },
  remove: () => {
    if (existsSync(authFile)) rmSync(authFile);
  },
});

// --- Convenience wrappers (what the bin calls; compose the core + real factories) ---
// These keep the bin simple (no factory wiring in the bin) while the injectable
// core above stays unit-testable. NOT a parallel system — they delegate to the
// tested primitives + the real DeviceFlowClient/AuthStore factories.

/** The config shape `whoami` returns (richer than AuthState — includes email for display). */
export interface WhoamiConfig extends AuthState {
  readonly email?: string;
  readonly planId: PlanId;
  readonly usage?: { readonly cloudCreditsUsedThisMonth: number; readonly nativeAgentReviewsUsedThisMonth: number };
}

/**
 * `gitgecko login` — the full device-linking flow. Wires the real client + store,
 * runs requestDeviceCode → print URL → pollForToken → saveAuth. Returns a
 * human-readable result the bin prints. When the cloud is unreachable
 * (self-hosted/local/offline), returns a helpful message — login is optional.
 */
export const login = async (): Promise<{ success: boolean; message: string }> => {
  const cloudUrl = CLOUD_URL();
  try {
    const client = createRealDeviceFlowClient(cloudUrl);
    const store = createFileAuthStore();

    // Step 1: request the device code.
    const dc = await requestDeviceCode(client);

    // Step 2: launch the verification URL, retaining a headless fallback.
    const verificationUrl = dc.verificationUriComplete;
    const opened = shouldOpenDeviceApproval(process.env)
      ? await openDeviceApproval(verificationUrl)
      : false;
    console.log("");
    console.log(opened ? "Browser opened to link this device:" : "Open this URL in your browser to link this device:");
    console.log(`  ${verificationUrl}`);
    console.log("");
    console.log("Waiting for authorization...");

    // Step 3: poll until authorized or the code expires.
    const maxAttempts = Math.floor(dc.expiresIn / Math.max(dc.interval, 1));
    const result = await pollForToken(client, dc.deviceCode, {
      maxAttempts,
      intervalMs: dc.interval * 1000,
    });

    if (result.status === "timeout") {
      return { success: false, message: "Timed out waiting for authorization. Run `gitgecko login` again." };
    }
    if (result.status !== "ok") {
      return { success: false, message: "The device authorization expired or was denied. Run `gitgecko login` again." };
    }

    // Step 4: save the auth state.
    await saveAuth(store, {
      version: 2,
      token: result.token,
      deviceId: result.deviceId,
      cloudUrl,
    });

    return {
      success: true,
      message: `Logged in. Plan: ${result.planId}. Device linked — visible at ${cloudUrl}/settings/devices.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      message:
        `Could not reach the cloud at ${cloudUrl} (${msg}).\n` +
        "Login is optional — local reviews work without it.\n" +
        "Set GITGECKO_CLOUD_URL for self-hosted.",
    };
  }
};

/** `gitgecko whoami` — show the current auth status. */
export const whoami = async (
  request: typeof fetch = fetch,
  store: AuthStore = createFileAuthStore(),
): Promise<{ loggedIn: boolean; config?: WhoamiConfig }> => {
  const auth = loadAuth(store);
  if (!auth) return { loggedIn: false };
  try {
    const response = await request(`${auth.cloudUrl.replace(/\/$/, "")}/account`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (!response.ok) return { loggedIn: false };
    const account = await response.json() as { planId: PlanId; usage?: WhoamiConfig["usage"]; email?: string };
    return {
      loggedIn: true,
      config: {
        ...auth,
        planId: account.planId,
        ...(account.usage ? { usage: account.usage } : {}),
        ...(account.email ? { email: account.email } : {}),
      },
    };
  } catch {
    return { loggedIn: false };
  }
};

/** `gitgecko logout` command — unlink this device (removes `~/gitgecko/auth.json`). */
export const logoutCommand = async (): Promise<{ success: boolean; message: string }> => {
  const store = createFileAuthStore();
  const auth = store.read();
  if (auth) {
    try {
      await createRealDeviceFlowClient(auth.cloudUrl).revokeToken?.(auth.token, auth.deviceId);
    } catch {
      // Local removal still prevents this machine from using the token. The
      // server-side token remains bounded by its device revocation policy.
    }
  }
  store.remove();
  return { success: true, message: "Logged out. Device token revoked locally and remotely when reachable." };
};
