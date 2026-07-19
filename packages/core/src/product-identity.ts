/** Canonical public identity for the GitGecko product surface. */
export const productIdentity = {
  name: "GitGecko",
  shortName: "GitGecko",
  domain: "gitgecko.com",
  siteUrl: "https://gitgecko.com",
  cloudUrl: "https://app.gitgecko.com",
  packageName: "gitgecko",
  cliCommand: "gitgecko",
  installCommand: "npm i -g gitgecko",
  reviewCommand: "gitgecko review",
  repositoryUrl: "https://github.com/savageops/gitgecko",
  authDirectory: "gitgecko",
  env: {
    cloudUrl: "GITGECKO_CLOUD_URL",
    repositoryUrl: "GITGECKO_REPOSITORY_URL",
  },
} as const;

/** Resolve the canonical public cloud URL from one owned environment variable. */
export const resolveProductCloudUrl = (env: Readonly<Record<string, string | undefined>>): string => {
  const canonical = env.GITGECKO_CLOUD_URL?.trim();
  return canonical || productIdentity.cloudUrl;
};

/** Resolve the source repository once for every public link and redirect. */
export const resolveProductRepositoryUrl = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const configured = env.GITGECKO_REPOSITORY_URL?.trim()
    || env.NEXT_PUBLIC_GITGECKO_REPOSITORY_URL?.trim();
  if (!configured) return productIdentity.repositoryUrl;

  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || !url.hostname) return productIdentity.repositoryUrl;
    return url.toString().replace(/\.git\/?$/, "").replace(/\/$/, "");
  } catch {
    return productIdentity.repositoryUrl;
  }
};

export type ProductIdentity = typeof productIdentity;
