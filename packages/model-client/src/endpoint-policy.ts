import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type ProviderTopology = "cloud" | "local";

export interface ProviderDnsAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ProviderDnsResolver = (hostname: string) => Promise<readonly ProviderDnsAddress[]>;

export interface ValidatedCloudProviderEndpoint {
  readonly url: URL;
  /** Preflight evidence only. A safe transport must connect through these exact addresses. */
  readonly addresses: readonly string[];
}

const forbiddenIpv4 = new BlockList();
const forbiddenIpv6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) forbiddenIpv4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) forbiddenIpv6.addSubnet(network, prefix, "ipv6");

const hostnameOnly = (hostname: string): string => hostname.startsWith("[") && hostname.endsWith("]")
  ? hostname.slice(1, -1)
  : hostname;

/** Reject every address that is not suitable for cloud provider egress. */
export function isForbiddenProviderAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return family === 4
    ? forbiddenIpv4.check(address, "ipv4")
    : forbiddenIpv6.check(address, "ipv6");
}

/** Parse topology-aware endpoint syntax without claiming DNS or transport safety. */
export function parseProviderEndpoint(input: {
  readonly baseUrl: string;
  readonly topology: ProviderTopology;
  readonly allowedHosts?: string;
}): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(input.baseUrl);
  } catch {
    throw new Error("provider endpoint must be a valid absolute URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("provider endpoint must use HTTP or HTTPS");
  }
  if (input.topology === "cloud" && endpoint.protocol !== "https:") {
    throw new Error("cloud provider endpoint must use HTTPS");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("provider credentials must not appear in the endpoint URL");
  }
  if (endpoint.hash) throw new Error("provider endpoint fragments are not allowed");
  if (input.topology === "cloud") {
    const allowed = new Set((input.allowedHosts ?? "")
      .split(",")
      .map((authority) => authority.trim().toLowerCase())
      .filter(Boolean));
    const authority = endpoint.port
      ? `${endpoint.hostname.toLowerCase()}:${endpoint.port}`
      : endpoint.hostname.toLowerCase();
    if (!allowed.has(authority)) {
      throw new Error("cloud provider endpoint must use an operator-allowlisted authority");
    }
  }
  return endpoint;
}

const systemResolver: ProviderDnsResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) => answer.family === 4 || answer.family === 6
    ? [{ address: answer.address, family: answer.family }]
    : []);
};

/** Resolve cloud egress as preflight evidence; connection pinning remains a transport obligation. */
export async function validateCloudProviderEndpoint(
  baseUrl: string,
  allowedHosts: string | undefined,
  resolver: ProviderDnsResolver = systemResolver,
): Promise<ValidatedCloudProviderEndpoint> {
  const url = parseProviderEndpoint({ baseUrl, topology: "cloud", ...(allowedHosts ? { allowedHosts } : {}) });
  const hostname = hostnameOnly(url.hostname);
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isForbiddenProviderAddress(hostname)) throw new Error("cloud provider endpoint resolves to a forbidden address");
    return { url, addresses: [hostname] };
  }
  let answers: readonly ProviderDnsAddress[];
  try {
    answers = await resolver(hostname);
  } catch {
    throw new Error("provider hostname could not be resolved");
  }
  const addresses = [...new Set(answers.map((answer) => answer.address))];
  if (addresses.length === 0) throw new Error("provider hostname returned no addresses");
  if (addresses.some(isForbiddenProviderAddress)) {
    throw new Error("cloud provider endpoint resolves to a forbidden address");
  }
  return { url, addresses };
}
