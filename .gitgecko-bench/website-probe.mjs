import tls from "node:tls";
import { writeFileSync } from "node:fs";

const base = "https://gitgecko.com";
const seeds = ["/", "/docs", "/login", "/docs/api", "/blog", "/changelog", "/roadmap", "/robots.txt", "/sitemap.xml", "/.well-known/security.txt"];
const userAgent = "GitGecko-Deep-BlackBox/2.0";
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
};
const extract = (html, regex) => [...html.matchAll(regex)].map((match) => match[1]);
const fetchRoute = async (path, method = "GET") => {
  const started = performance.now();
  try {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "follow",
      headers: {
        "user-agent": userAgent,
        "accept-encoding": "br, gzip, deflate",
      },
    });
    const body = method === "HEAD" ? "" : await response.text();
    return {
      path,
      method,
      status: response.status,
      finalUrl: response.url,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      bytes: Buffer.byteLength(body),
      contentType: response.headers.get("content-type"),
      contentEncoding: response.headers.get("content-encoding"),
      cacheControl: response.headers.get("cache-control"),
      etag: response.headers.get("etag"),
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  } catch (error) {
    return { path, method, status: 0, durationMs: Math.round((performance.now() - started) * 100) / 100, error: error.message, body: "", headers: {} };
  }
};

const seeded = [];
for (const path of seeds) seeded.push(await fetchRoute(path));
const htmlPages = seeded.filter((page) => page.contentType?.includes("text/html"));
const internalLinks = new Set();
for (const page of htmlPages) {
  for (const href of extract(page.body, /<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(href, base);
      if (url.origin === base && !url.pathname.startsWith("/_next/") && !url.pathname.startsWith("/api/")) {
        internalLinks.add(`${url.pathname}${url.search}`);
      }
    } catch {}
  }
}
const linkResults = [];
for (const path of [...internalLinks].sort().slice(0, 150)) linkResults.push(await fetchRoute(path));

const perf = {};
for (const path of ["/", "/docs", "/login"]) {
  const samples = [];
  for (let index = 0; index < 8; index += 1) samples.push((await fetchRoute(path)).durationMs);
  perf[path] = {
    samples,
    minMs: Math.min(...samples),
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: Math.max(...samples),
  };
}

const tlsInfo = await new Promise((resolvePromise) => {
  const socket = tls.connect(443, "gitgecko.com", { servername: "gitgecko.com", rejectUnauthorized: true }, () => {
    const certificate = socket.getPeerCertificate(true);
    resolvePromise({
      authorized: socket.authorized,
      authorizationError: socket.authorizationError,
      protocol: socket.getProtocol(),
      cipher: socket.getCipher(),
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: certificate.valid_from,
      validTo: certificate.valid_to,
      subjectAltName: certificate.subjectaltname,
      fingerprint256: certificate.fingerprint256,
    });
    socket.end();
  });
  socket.setTimeout(15_000, () => { socket.destroy(); resolvePromise({ error: "TLS timeout" }); });
  socket.on("error", (error) => resolvePromise({ error: error.message }));
});

const byPath = Object.fromEntries(seeded.map((page) => [page.path, page]));
const home = byPath["/"]?.body ?? "";
const docs = byPath["/docs"]?.body ?? "";
const securityHeaders = [
  "content-security-policy",
  "strict-transport-security",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
  "x-frame-options",
  "cross-origin-opener-policy",
  "cross-origin-resource-policy",
  "cross-origin-embedder-policy",
];
const headerCoverage = {};
for (const path of ["/", "/docs", "/login"]) {
  const headers = byPath[path]?.headers ?? {};
  headerCoverage[path] = Object.fromEntries(securityHeaders.map((name) => [name, headers[name] ?? null]));
}
const metaFor = (html) => ({
  title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim(),
  description: html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1],
  canonical: html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1],
  ogTitle: html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)?.[1],
  ogDescription: html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1],
  ogImage: html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']*)["']/i)?.[1],
  viewport: html.match(/<meta[^>]+name=["']viewport["'][^>]+content=["']([^"']*)["']/i)?.[1],
  h1Count: (html.match(/<h1\b/gi) ?? []).length,
  mainCount: (html.match(/<main\b/gi) ?? []).length,
  navCount: (html.match(/<nav\b/gi) ?? []).length,
  buttonCount: (html.match(/<button\b/gi) ?? []).length,
  formCount: (html.match(/<form\b/gi) ?? []).length,
  labelCount: (html.match(/<label\b/gi) ?? []).length,
  imageCount: (html.match(/<img\b/gi) ?? []).length,
  imagesWithoutAlt: (html.match(/<img\b(?![^>]*\balt=)[^>]*>/gi) ?? []).length,
});

const summary = {
  testedAt: new Date().toISOString(),
  base,
  tls: tlsInfo,
  seededRoutes: seeded.map(({ body, ...page }) => page),
  discoveredInternalLinks: [...internalLinks].sort(),
  brokenInternalLinks: linkResults.filter((page) => page.status >= 400 || page.status === 0).map(({ body, ...page }) => page),
  redirectingInternalLinks: linkResults.filter((page) => page.finalUrl && page.finalUrl !== new URL(page.path, base).href).map(({ body, ...page }) => page),
  linkStatusCounts: linkResults.reduce((counts, page) => {
    counts[page.status] = (counts[page.status] ?? 0) + 1;
    return counts;
  }, {}),
  performance: perf,
  commandContract: {
    homepage: {
      globalInstall: home.includes("npm i -g gitgecko"),
      npx: home.includes("npx gitgecko"),
      npxLatest: home.includes("gitgecko@latest"),
      nodeMention: /Node\.js/i.test(home),
      node2219: /22\.19/i.test(home),
      doctor: home.includes("gitgecko doctor"),
      review: home.includes("gitgecko review"),
    },
    docs: {
      globalInstall: docs.includes("npm i -g gitgecko"),
      npx: docs.includes("npx gitgecko"),
      npxLatest: docs.includes("gitgecko@latest"),
      nodeMention: /Node\.js/i.test(docs),
      node2219: /22\.19/i.test(docs),
      doctor: docs.includes("gitgecko doctor"),
      review: docs.includes("gitgecko review"),
    },
  },
  metadata: {
    home: metaFor(home),
    docs: metaFor(docs),
    login: metaFor(byPath["/login"]?.body ?? ""),
  },
  securityHeaders: headerCoverage,
  robots: { status: byPath["/robots.txt"]?.status, body: byPath["/robots.txt"]?.body },
  sitemap: { status: byPath["/sitemap.xml"]?.status, bytes: byPath["/sitemap.xml"]?.bytes, bodyPrefix: byPath["/sitemap.xml"]?.body?.slice(0, 2_000) },
  securityTxt: { status: byPath["/.well-known/security.txt"]?.status, body: byPath["/.well-known/security.txt"]?.body },
};

console.log(JSON.stringify(summary, null, 2));
if (process.env.GITHUB_STEP_SUMMARY) {
  const missingHeaders = Object.values(summary.securityHeaders["/"]).filter((value) => value === null).length;
  const line = `## GitGecko website probe\n\n- Discovered internal links: **${summary.discoveredInternalLinks.length}**.\n- Broken internal links: **${summary.brokenInternalLinks.length}**.\n- Homepage p50/p95: **${perf["/"].p50Ms}/${perf["/"].p95Ms} ms**.\n- Homepage mentions npx: **${summary.commandContract.homepage.npx}**.\n- Homepage mentions Node 22.19: **${summary.commandContract.homepage.node2219}**.\n- Missing queried security headers on homepage: **${missingHeaders}/${securityHeaders.length}**.\n`;
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, line, { flag: "a" });
}
