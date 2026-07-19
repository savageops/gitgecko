import type { LookupOptions } from "node:dns";
import { isIP } from "node:net";
import type { ConnectionOptions } from "node:tls";

import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";

import {
  validateCloudProviderEndpoint,
  type ProviderDnsResolver,
  type ValidatedCloudProviderEndpoint,
} from "./endpoint-policy.js";

const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
] as const;

type PinnedLookup = NonNullable<ConnectionOptions["lookup"]>;

export interface PinnedProviderTransport {
  readonly fetch: typeof globalThis.fetch;
  close(): Promise<void>;
}

interface ProviderTransportDependencies {
  readonly resolver?: ProviderDnsResolver;
  readonly maxRedirects?: number;
  readonly fetch?: typeof undiciFetch;
  readonly createDispatcher?: (endpoint: ValidatedCloudProviderEndpoint) => Dispatcher;
}

/** Restrict a TLS connection's DNS lookup to the endpoint's validated addresses. */
export function createPinnedLookup(expectedHostname: string, addresses: readonly string[]): PinnedLookup {
  if (addresses.length === 0) throw new Error("pinned provider transport requires at least one address");
  const normalizedHostname = expectedHostname.toLowerCase();
  const records = addresses.map((address) => {
    const family = isIP(address);
    if (family !== 4 && family !== 6) throw new Error("pinned provider transport received an invalid address");
    return { address, family } as const;
  });
  let cursor = 0;
  return ((hostname: string, options: LookupOptions, callback: (...args: unknown[]) => void) => {
    if (hostname.toLowerCase() !== normalizedHostname) {
      const error = Object.assign(new Error("provider transport hostname changed after validation"), { code: "ENOTFOUND" });
      callback(error);
      return;
    }
    if (options.all) {
      callback(null, records.map((record) => ({ ...record })));
      return;
    }
    const requestedFamily = options.family === 4 || options.family === 6 ? options.family : undefined;
    const candidates = requestedFamily ? records.filter((record) => record.family === requestedFamily) : records;
    if (candidates.length === 0) {
      const error = Object.assign(new Error("provider transport has no validated address for the requested family"), { code: "ENOTFOUND" });
      callback(error);
      return;
    }
    const selected = candidates[cursor % candidates.length]!;
    cursor += 1;
    callback(null, selected.address, selected.family);
  }) as PinnedLookup;
}

/** Create one dispatcher whose TLS SNI remains the hostname while DNS is pinned. */
export function createPinnedDispatcher(endpoint: ValidatedCloudProviderEndpoint): Dispatcher {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(endpoint.url.hostname, endpoint.addresses),
    },
  });
}

const inputUrl = (input: Parameters<typeof globalThis.fetch>[0]): URL => {
  if (typeof input === "string" || input instanceof URL) return new URL(input);
  return new URL(input.url);
};

const requestHeaders = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Headers => {
  const headers = new Headers(typeof input === "string" || input instanceof URL ? undefined : input.headers);
  if (init?.headers) new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  headers.delete("host");
  return headers;
};

const requestBody = async (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1],
): Promise<unknown> => {
  if (init?.body !== undefined && init.body !== null) return init.body;
  if (typeof input === "string" || input instanceof URL || input.body === null) return undefined;
  return new Uint8Array(await input.clone().arrayBuffer());
};

const redirectLocation = (response: Response, current: URL): URL | undefined => {
  if (!REDIRECT_STATUSES.has(response.status)) return undefined;
  const location = response.headers.get("location");
  if (!location) throw new Error("provider redirect omitted its location");
  return new URL(location, current);
};

/**
 * Build an SDK-compatible fetch that validates and pins every request hop.
 * Dispatchers remain alive for streamed response bodies and close with the
 * request scope owned by the caller.
 */
export function createPinnedProviderTransport(
  allowedHosts: string | undefined,
  dependencies: ProviderTransportDependencies = {},
): PinnedProviderTransport {
  const maxRedirects = dependencies.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > DEFAULT_MAX_REDIRECTS) {
    throw new Error(`provider redirect limit must be between 0 and ${DEFAULT_MAX_REDIRECTS}`);
  }
  const fetchImpl = dependencies.fetch ?? undiciFetch;
  const dispatcherFactory = dependencies.createDispatcher ?? createPinnedDispatcher;
  const dispatchers = new Map<string, Dispatcher>();
  let closed = false;

  const dispatcherFor = (endpoint: ValidatedCloudProviderEndpoint): Dispatcher => {
    const key = `${endpoint.url.origin}\0${[...endpoint.addresses].sort().join(",")}`;
    const existing = dispatchers.get(key);
    if (existing) return existing;
    const dispatcher = dispatcherFactory(endpoint);
    dispatchers.set(key, dispatcher);
    return dispatcher;
  };

  const pinnedFetch = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    if (closed) throw new Error("provider transport is closed");
    let current = inputUrl(input);
    const method = (init?.method ?? (typeof input === "string" || input instanceof URL ? "GET" : input.method)).toUpperCase();
    const body = await requestBody(input, init);
    const headers = requestHeaders(input, init);

    for (let redirectCount = 0; ; redirectCount += 1) {
      const endpoint = await validateCloudProviderEndpoint(current.href, allowedHosts, dependencies.resolver);
      const dispatcher = dispatcherFor(endpoint);
      const response = await fetchImpl(current, {
        ...init,
        method,
        headers: headers as never,
        body: method === "GET" || method === "HEAD" ? undefined : body as never,
        redirect: "manual",
        dispatcher,
      } as never);
      const next = redirectLocation(response as unknown as Response, current);
      if (!next) return response as unknown as Response;
      await response.body?.cancel();
      if (redirectCount >= maxRedirects) throw new Error("provider redirect limit exceeded");
      if (response.status !== 307 && response.status !== 308) {
        throw new Error("provider redirect must preserve the request method");
      }
      if (next.origin !== current.origin) {
        for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      }
      current = next;
    }
  };

  return {
    fetch: pinnedFetch as typeof globalThis.fetch,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all([...dispatchers.values()].map((dispatcher) => dispatcher.close()));
      dispatchers.clear();
    },
  };
}
