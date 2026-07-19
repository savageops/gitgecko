/**
 * Canonical GitHub repository identity normalization shared by CLI and cloud
 * ingress. A project is keyed by this normalized HTTPS URL, not by whatever
 * remote syntax a user's Git client happens to return.
 */
export interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  readonly url: string;
}

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** Normalize HTTPS, shorthand, and SSH GitHub remotes to one project URL. */
export const normalizeGitHubRepository = (value: string): GitHubRepositoryIdentity | undefined => {
  const raw = value.trim();
  if (!raw) return undefined;

  const sshMatch = raw.match(/^(?:ssh:\/\/git@github\.com[:/]|git@github\.com:)([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  const shorthandMatch = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  const match = sshMatch ?? shorthandMatch;
  if (!match) return undefined;

  const owner = match[1]!.trim();
  const name = match[2]!.trim();
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(name)) return undefined;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
};

/** Return the user-facing owner/name label for a normalized GitHub remote. */
export const githubRepositoryName = (value: string): string | undefined => {
  const repository = normalizeGitHubRepository(value);
  return repository ? `${repository.owner}/${repository.name}` : undefined;
};
