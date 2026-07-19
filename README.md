# GitGecko

Code review that starts with the tools already on your machine.

GitGecko reviews a repository or diff. It runs repeatable rules first, then
uses an installed coding CLI or configured model route for the judgment calls.
Findings explain the consequence, not only the matching line. Local reviews are
read-only by default and do not require a GitGecko account.

## Install and run

Requires Node.js 22 or newer.

```bash
npm i -g gitgecko

gitgecko doctor   # see the detected review path
gitgecko review  # review the current repository
```

The npm package is the complete local CLI. You do not need to clone the
repository for this workflow.

`doctor` is the best first command. It checks Node, installed coding CLIs,
model routes, and the selected path. If something is missing, it names the next
step.

## Common reviews

```bash
# Review a branch diff
gitgecko review --diff "$(git diff main)"

# Review selected files
gitgecko review --file src/auth.ts --file src/session.ts

# Prepare a pull-request description
gitgecko describe --diff "$(git diff main)"

# Ask for improvements without running the full review
gitgecko improve --diff "$(git diff main)"

# Ask a focused question about the change
gitgecko ask "Does this introduce a race condition?" --diff "$(git diff main)"
```

## How provider selection works

With `--pathway auto` (the default), GitGecko checks for a supported installed
coding CLI, then a configured model endpoint. The CLI keeps its own login;
GitGecko does not create a second credential for it.

| Pathway | When to use it |
| --- | --- |
| `codex`, `claude`, `opencode` | Use the installed CLI and its existing login |
| `pi` | Use the model route saved with `gitgecko models configure` |
| `native-loop` | Use the advanced API-backed model route |
| `deterministic` | Run repeatable `ast-grep` and regex rules without a model |

Choose a pathway explicitly when you need reproducible CI behavior:

```bash
gitgecko review --pathway claude
gitgecko review --pathway pi
gitgecko review --pathway auto
```

The deterministic lane runs first where the review pipeline supports it. Its
findings are repeatable and separate from model-generated suggestions.

## Commands

| Command | Purpose |
| --- | --- |
| `gitgecko doctor` | Diagnose the local install and provider path |
| `gitgecko review` | Produce a severity-tagged code review |
| `gitgecko describe` | Draft a PR title, summary, and walkthrough |
| `gitgecko improve` | Return improvement suggestions |
| `gitgecko ask` | Answer a question using the diff and repository context |
| `gitgecko threads start\|resume\|list\|read\|delete` | Manage GitGecko-owned agent threads |
| `gitgecko login` / `whoami` | Connect to the hosted private preview |
| `gitgecko help` / `version` | Show CLI help or version |

Reviews use `read-only` permissions by default. `workspace-write` and
`unrestricted` require an explicit `--permission` value.

## Configuration

Local use needs no GitGecko cloud account. Set one of these only when you want
model-backed review without an installed coding CLI:

| Variable | Provider |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic |
| `OPENAI_API_KEY` | OpenAI |
| `GITGECKO_LOCAL_BASE_URL` | LM Studio, Ollama, vLLM, or another compatible endpoint |

The full list of model, timeout, GitHub, MCP, and cloud settings is in
[`.env.example`](./.env.example). `gitgecko doctor` reports the effective
configuration without printing secret values.

To include local build or test evidence in a review, add bounded commands to
`~/gitgecko/config.json`, then opt in with `gitgecko review --run-checks`:

```json
{
  "version": 1,
  "reviewChecks": [
    { "id": "tests", "label": "Tests", "command": "npm", "args": ["test"], "timeoutMs": 120000 },
    { "id": "lint", "label": "Lint", "command": "npm", "args": ["run", "lint"], "required": false }
  ]
}
```

Commands run without shell interpolation in the reviewed directory. Output is
bounded and attached to `review.v2`; required failures make the artifact
non-mergeable. This option is local-only until hosted workers can execute the
checks themselves rather than trusting client-reported receipts.

## CI and self-hosting

For a pull-request check, use the repository action from a trusted,
commit-pinned ref:

```yaml
- name: Review pull request
  uses: savageops/gitgecko@472543206e5d82bcb2386d78c1bd29d1a04a9b25
```

**Option A — the reusable action (recommended):**

```yaml
name: GitGecko review

on:
  pull_request_target:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: savageops/gitgecko@472543206e5d82bcb2386d78c1bd29d1a04a9b25
```

The action can run the deterministic baseline without model credentials. Add a
supported provider only when model-backed findings are wanted.

The hosted workspace at [gitgecko.com](https://gitgecko.com) is currently a
private preview. Local reviews remain independent of that account boundary.

## Why GitGecko

- **Keep the login you have.** Codex, Claude Code, and OpenCode run through the
  account already configured on the machine.
- **Know which claims are repeatable.** `ast-grep` and regex findings stay
  separate from model judgment.
- **Set a model route when you need one.** Save LM Studio, Ollama, vLLM, or
  another compatible endpoint with `gitgecko models configure`.
- **See the consequence.** Findings connect the changed code to the breakage it
  can cause.
- **Check the trail.** Every finding carries severity, location, and source;
  model judgment does not masquerade as a rule result.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
```

Node.js 22+ and pnpm 11+ are required. To build the publishable CLI bundle:

```bash
pnpm build:cli
node dist/gitgecko.js doctor
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
