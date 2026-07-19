/**
 * TDD tests for the CLI device-linking auth flow (`gitgecko login` → `~/gitgecko/auth.json`).
 *
 * THE CAPABILITY: the OAuth device-flow (the normalized pattern — GitHub CLI,
 * Stripe CLI, Vercel CLI all use it). `gitgecko login` → request a device code →
 * print verification URL → poll until the user authorizes → write auth.json → the device
 * appears in the platform's /settings/devices. NOT a new invention — users
 * already know this flow from every major CLI.
 *
 * Pure unit tests: the device-flow HTTP client + auth.json I/O are INJECTED (no
 * real network, no real filesystem). Per project TDD rule: written FIRST.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  requestDeviceCode,
  pollForToken,
  saveAuth,
  loadAuth,
  removeAuthState,
  getAuthFilePath,
  createFileAuthStore,
  createRealDeviceFlowClient,
  openDeviceApproval,
  shouldOpenDeviceApproval,
  whoami,
  type DeviceCodeResponse,
  type DeviceFlowClient,
  type AuthState,
  type AuthStore,
} from "./auth.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Fakes ---

const makeFakeClient = (behaviour: {
  deviceCode?: Partial<DeviceCodeResponse>;
  tokenAfter?: number; // poll succeeds after N calls
  token?: string;
}): DeviceFlowClient => {
  let calls = 0;
  return {
    requestDeviceCode: async () => ({
      deviceCode: "dc_test",
      userCode: "USER-CODE",
      verificationUri: "https://gitgecko.com/login/device",
      verificationUriComplete: "https://gitgecko.com/login/device?code=USER-CODE",
      expiresIn: 900,
      interval: 1,
      ...behaviour.deviceCode,
    }),
    pollForToken: async () => {
      calls++;
      if (behaviour.tokenAfter !== undefined && calls < behaviour.tokenAfter) {
        return { status: "pending" as const };
      }
      return {
        status: "ok" as const,
        token: behaviour.token ?? "tok_dev_123",
        planId: "free",
        deviceId: "dev_server_123",
      };
    },
  };
};

const makeFakeStore = (existing?: AuthState): { store: AuthStore; written: AuthState[] } => {
  const written: AuthState[] = [];
  let current: AuthState | undefined = existing;
  return {
    written,
    store: {
      read: () => current,
      write: (state: AuthState) => { current = state; written.push(state); },
      remove: () => { current = undefined; },
    },
  };
};

// --- Tests ---

describe("requestDeviceCode — the first step of the device flow", () => {
  it("returns the device code + the verification URL the user opens", async () => {
    const client = makeFakeClient({});
    const res = await requestDeviceCode(client);
    assert.ok(res.deviceCode);
    assert.ok(res.userCode);
    assert.ok(res.verificationUri, "must give the user a URL to open");
    assert.ok(res.expiresIn > 0);
  });
});

describe("pollForToken — polls until the user authorizes the device", () => {
  it("returns the token + planId once authorized", async () => {
    const client = makeFakeClient({ tokenAfter: 1, token: "tok_abc", });
    const res = await pollForToken(client, "dc_test", { maxAttempts: 5, intervalMs: 0 });
    assert.equal(res.status, "ok");
    if (res.status === "ok") {
      assert.equal(res.token, "tok_abc");
      assert.equal(res.planId, "free");
      assert.equal(res.deviceId, "dev_server_123", "device identity must come from the server");
    }
  });

  it("returns 'pending' while the user has not yet authorized", async () => {
    const client = makeFakeClient({ tokenAfter: 10 }); // never succeeds within attempts
    const res = await pollForToken(client, "dc_test", { maxAttempts: 2, intervalMs: 0 });
    assert.equal(res.status, "timeout", "exhausting attempts without success = timeout");
  });

  it("respects maxAttempts (does not poll forever)", async () => {
    const client = makeFakeClient({ tokenAfter: 100 });
    const res = await pollForToken(client, "dc_test", { maxAttempts: 3, intervalMs: 0 });
    assert.equal(res.status, "timeout");
  });

  it("honors slow_down before accepting a later token", async () => {
    let calls = 0;
    const client: DeviceFlowClient = {
      requestDeviceCode: async () => ({ deviceCode: "dc", userCode: "code", verificationUri: "https://cloud", verificationUriComplete: "https://cloud?code=code", expiresIn: 60, interval: 1 }),
      pollForToken: async () => {
        calls += 1;
        return calls === 1
          ? { status: "slow_down" as const }
          : { status: "ok" as const, token: "token", planId: "free" as const, deviceId: "device" };
      },
    };
    const result = await pollForToken(client, "dc", { maxAttempts: 2, intervalMs: -5_000 });
    assert.equal(result.status, "ok");
    assert.equal(calls, 2);
  });

  it("accepts a server-provided retry window without changing the result contract", async () => {
    let calls = 0;
    const client: DeviceFlowClient = {
      requestDeviceCode: async () => ({ deviceCode: "dc", userCode: "code", verificationUri: "https://cloud", verificationUriComplete: "https://cloud?code=code", expiresIn: 60, interval: 1 }),
      pollForToken: async () => {
        calls += 1;
        return calls === 1
          ? { status: "slow_down" as const, retryAfterMs: 0 }
          : { status: "ok" as const, token: "token", planId: "free" as const, deviceId: "device" };
      },
    };
    const result = await pollForToken(client, "dc", { maxAttempts: 2, intervalMs: 0 });
    assert.equal(result.status, "ok");
    assert.equal(calls, 2);
  });
});

describe("real device-flow polling boundary", () => {
  it("accepts only an explicit pending response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
    try {
      assert.deepEqual(await createRealDeviceFlowClient("https://cloud.example").pollForToken("dc"), { status: "pending" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces dependency failures instead of treating them as pending", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "service_unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Retry-After": "5" },
    });
    try {
      await assert.rejects(
        createRealDeviceFlowClient("https://cloud.example").pollForToken("dc"),
        /returned 503 while polling/i,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const [wireError, status] of [["expired_token", "expired"], ["access_denied", "denied"]] as const) {
    it(`maps RFC ${wireError} to the ${status} lifecycle state`, async () => {
      const client = createRealDeviceFlowClient("https://cloud.example", async () => new Response(
        JSON.stringify({ error: wireError }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));
      assert.deepEqual(await client.pollForToken("dc"), { status });
    });
  }
});

describe("device approval browser handoff", () => {
  it("keeps browser launch enabled unless the operator explicitly disables it", () => {
    assert.equal(shouldOpenDeviceApproval({}), true);
    assert.equal(shouldOpenDeviceApproval({ GITGECKO_NO_BROWSER: "0" }), true);
    assert.equal(shouldOpenDeviceApproval({ GITGECKO_NO_BROWSER: "1" }), false);
  });

  it("opens the exact verification URL", async () => {
    let opened: string | undefined;
    const result = await openDeviceApproval("https://gitgecko.com/login/device?code=ABCD", async (target) => {
      opened = target;
    });
    assert.equal(result, true);
    assert.equal(opened, "https://gitgecko.com/login/device?code=ABCD");
  });

  it("returns a printable-fallback signal when browser launch fails", async () => {
    const result = await openDeviceApproval("https://gitgecko.com/login/device?code=ABCD", async () => {
      throw new Error("headless host");
    });
    assert.equal(result, false);
  });
});

describe("saveAuth / loadAuth / logout — the ~/gitgecko/auth.json lifecycle", () => {
  it("saveAuth writes version 2 without trusting a cached plan", async () => {
    const { store, written } = makeFakeStore();
    await saveAuth(store, { version: 2, token: "tok_x", deviceId: "dev_1", cloudUrl: "https://gitgecko.com" });
    assert.equal(written.length, 1);
    assert.equal(written[0]!.token, "tok_x");
    assert.equal(written[0]!.version, 2);
    assert.equal("planId" in written[0]!, false);
    assert.equal(written[0]!.deviceId, "dev_1");
  });

  it("loadAuth returns the saved state", async () => {
    const { store } = makeFakeStore({ version: 2, token: "tok_y", deviceId: "dev_2", cloudUrl: "https://gitgecko.com" });
    const auth = loadAuth(store);
    assert.ok(auth);
    assert.equal(auth!.token, "tok_y");
    assert.equal(auth!.version, 2);
  });

  it("loadAuth returns undefined when not authenticated (no auth.json)", async () => {
    const { store } = makeFakeStore(undefined);
    assert.equal(loadAuth(store), undefined);
  });

  it("logout removes the auth state", async () => {
    const { store } = makeFakeStore({ version: 2, token: "tok_z", deviceId: "dev_3", cloudUrl: "https://gitgecko.com" });
    removeAuthState(store);
    assert.equal(loadAuth(store), undefined);
  });
});

describe("auth state migration and live account authority", () => {
  it("migrates a v1 file once and removes cached plan authority", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-auth-"));
    const authFile = join(directory, "auth.json");
    try {
      writeFileSync(authFile, JSON.stringify({
        token: "legacy-token",
        planId: "max",
        deviceId: "legacy-device",
        cloudUrl: "https://cloud.example",
      }));
      const state = createFileAuthStore(authFile).read();
      assert.deepEqual(state, {
        version: 2,
        token: "legacy-token",
        deviceId: "legacy-device",
        cloudUrl: "https://cloud.example",
      });
      assert.equal(JSON.parse(readFileSync(authFile, "utf8")).planId, undefined);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unknown auth version without rewriting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "gitgecko-auth-version-"));
    const authFile = join(directory, "auth.json");
    const unknown = JSON.stringify({
      version: 3,
      token: "future-token",
      deviceId: "future-device",
      cloudUrl: "https://cloud.example",
    });
    try {
      writeFileSync(authFile, unknown);
      assert.equal(createFileAuthStore(authFile).read(), undefined);
      assert.equal(readFileSync(authFile, "utf8"), unknown);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("resolves whoami plan from the account endpoint instead of auth.json", async () => {
    const { store } = makeFakeStore({
      version: 2,
      token: "token",
      deviceId: "device",
      cloudUrl: "https://cloud.example",
    });
    const result = await whoami(async () => new Response(JSON.stringify({
      planId: "pro",
      usage: { cloudCreditsUsedThisMonth: 4, nativeAgentReviewsUsedThisMonth: 0 },
    }), { status: 200 }), store);
    assert.equal(result.config?.planId, "pro");
    assert.equal(result.config?.usage?.cloudCreditsUsedThisMonth, 4);
  });
});

describe("getAuthFilePath — the canonical ~/gitgecko/auth.json path", () => {
  it("resolves to <home>/gitgecko/auth.json", () => {
    const p = getAuthFilePath();
    assert.ok(
      p.endsWith("gitgecko/auth.json") || p.endsWith("gitgecko\\auth.json"),
      "must match the documented ~/gitgecko/auth.json contract",
    );
  });
});
