---
name: gitgecko-review
description: Run local-first code review with GitGecko through an installed Codex, Claude Code, or OpenCode subscription, a configured local model, BYOK, deterministic checks, or an explicitly linked hosted account. Use for reviewing working-tree changes, diffs, files, pull-request descriptions, improvement passes, focused code questions, runtime-check receipts, review history, and GitGecko native threads.
---

# GitGecko review

Operate GitGecko through the installed `gitgecko` command. Keep review read-only unless the user explicitly authorizes a broader permission.

## Operating order

1. Run `gitgecko doctor` when the available provider path is unknown.
2. Run `gitgecko review` in the repository for the default working-tree review.
3. Select `--pathway codex|claude|opencode|pi|deterministic|cloud` only when the user needs a specific owner.
4. Use `--json` for machine consumption and `--agent` for clean agent-oriented output.
5. Treat a nonzero exit or `mergeable: false` as review failure evidence; do not hide it.

## Inputs

- Current working tree: `gitgecko review`
- Explicit diff: `gitgecko review --diff "<unified diff>"`
- Diff file: `gitgecko review --diff-file <path>`
- Selected files: `gitgecko review --file <path> [--file <path>]`
- Focused question: `gitgecko ask "<question>" --diff "<unified diff>"`
- Pull-request copy: `gitgecko describe --diff "<unified diff>"`
- Improvement pass: `gitgecko improve --diff "<unified diff>"`

Use `--cwd <directory>` when the reviewed repository is not the current directory. Use `--run-checks` only when the repository owner has configured bounded commands in `~/gitgecko/config.json`.

## Provider boundaries

Prefer the user-owned installed CLI or configured local route. BYOK keys stay in the user's environment. `gitgecko auth` optionally links the client to the hosted dashboard and hosted model service; it is not required for local review.

A linked local review syncs findings and file metadata by default. Do not add raw source, diff content, raw model output, evidence, traces, or runtime logs to that sync contract without explicit user authorization.

Hosted credit enforcement, billing, entitlement, provider selection, credentials, dashboard state, and deployment are server-owned. Do not infer or reconstruct them from this repository.

## Threads

Use `gitgecko threads start|resume|list|read|delete` for GitGecko-owned native-agent threads. Preserve the returned thread ID when work must resume later.

## Failure handling

- Missing provider: run `gitgecko doctor`, then select an installed CLI or configure a local/BYOK route.
- Missing review input: provide a working-tree change, diff, diff file, or selected file.
- Dashboard sync failure: preserve the completed local review; report sync as a separate cloud availability failure.
- Hosted auth failure: run `gitgecko auth`; do not replace device auth with provider credentials.

