import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/** Convert a Windows path for MSYS Bash while leaving POSIX paths intact. */
function bashPath(path) {
  return path.replace(/^([A-Za-z]):[\\/]/, (_, drive) => `/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

/** Build a fake Action runner boundary without contacting GitHub or npm. */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "gitgecko-action-"));
  const bin = join(directory, "bin");
  const githubEnv = join(directory, "github-env");
  const argsFile = join(directory, "cli-args");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  const cli = join(bin, "gitgecko");
  const curl = join(bin, "curl");
  writeFileSync(gh, `#!/usr/bin/env bash
if [ "\${FAKE_GH_FAIL:-}" = "1" ]; then echo "credential-bearing gh failure" >&2; exit 9; fi
printf '%s\n' '--- app.ts' '+++ app.ts' '@@ -0,0 +1 @@' '+console.log("action");'
`);
  writeFileSync(cli, `#!/usr/bin/env bash
printf '%s\n' "$@" > "$FAKE_ARGS_FILE"
echo "GitGecko fixture review"
exit "\${FAKE_CLI_EXIT:-0}"
`);
  writeFileSync(curl, `#!/usr/bin/env bash
case "$*" in
  *audience=*)
    if [ "\${FAKE_OIDC_FAIL:-}" = "1" ]; then
      echo "credential-bearing oidc body" >&2
      exit 22
    fi
    printf '%s' '{"value":"fixture-oidc-token"}'
    ;;
  *)
    if [ "\${FAKE_CLOUD_FAIL:-}" = "1" ]; then
      echo "provider-internal cloud body" >&2
      exit 22
    fi
    printf '%s' '{"success":true,"output":"GitGecko cloud fixture review"}'
    ;;
esac
`);
  chmodSync(gh, 0o755);
  chmodSync(cli, 0o755);
  chmodSync(curl, 0o755);

  const env = {
    ...process.env,
    PATH: `${bashPath(bin)}:${process.env.PATH ?? ""}`,
    GITHUB_ENV: bashPath(githubEnv),
    GITGECKO_ACTION_PATH: bashPath(root),
    GITGECKO_PR_NUMBER: "42",
    GITGECKO_PR_TITLE: "Fixture PR",
    GITGECKO_PATHWAY: "auto",
    GITGECKO_MAX_TIMEOUT: "30",
    GITGECKO_CLOUD_URL: "",
    GITGECKO_CURL_BIN: bashPath(curl),
    FAKE_ARGS_FILE: bashPath(argsFile),
  };
  return { directory, githubEnv, argsFile, env };
}

/** Execute the exact shell owner referenced by action.yml. */
function run(env) {
  return spawnSync("bash", [bashPath(join(root, "scripts", "run-action-review.sh"))], {
    cwd: root,
    env,
    encoding: "utf8",
  });
}

test("Action runner reviews API patch data and exports the result contract", () => {
  const f = fixture();
  try {
    const result = run(f.env);
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(f.githubEnv, "utf8");
    assert.match(exported, /GitGecko fixture review/);
    assert.match(exported, /GITGECKO_REVIEW_EXIT_CODE=0/);
    const args = readFileSync(f.argsFile, "utf8");
    assert.match(args, /--diff-file/);
    assert.match(args, /--pathway\nauto/);
    assert.match(args, /--title\nFixture PR/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Action runner fails closed when pull-request patch ingestion fails", () => {
  const f = fixture();
  try {
    const result = run({ ...f.env, FAKE_GH_FAIL: "1" });
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(f.githubEnv, "utf8");
    assert.match(exported, /GitGecko could not load the review patch/);
    assert.match(exported, /GITGECKO_REVIEW_EXIT_CODE=2/);
    assert.doesNotMatch(exported, /credential-bearing/);
    assert.throws(() => readFileSync(f.argsFile, "utf8"));
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Action runner rejects invalid timeout bounds before reviewing", () => {
  const f = fixture();
  try {
    const result = run({ ...f.env, GITGECKO_MAX_TIMEOUT: "0" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /between 1 and 3600/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Action runner exchanges OIDC and exports successful cloud review output", () => {
  const f = fixture();
  try {
    const result = run({
      ...f.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc?request=1",
      GITGECKO_CLOUD_URL: "https://gitgecko.example",
    });
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(f.githubEnv, "utf8");
    assert.match(exported, /GitGecko cloud fixture review/);
    assert.match(exported, /GITGECKO_REVIEW_EXIT_CODE=0/);
    assert.throws(() => readFileSync(f.argsFile, "utf8"));
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Action runner preserves requirement evidence and fails a non-mergeable cloud review", () => {
  const f = fixture();
  try {
    const curl = join(f.directory, "bin", "curl");
    writeFileSync(curl, `#!/usr/bin/env bash
case "$*" in
  *audience=*) printf '%s' '{"value":"fixture-oidc-token"}' ;;
  *) printf '%s' '{"success":true,"output":"GitGecko cloud fixture review","artifact":{"mergeable":false,"linkedRequirements":[{"number":42,"title":"Protect login","url":"https://github.com/acme/repo/issues/42","status":"unmet","evidence":"No expiry check appears in the diff."}]}}' ;;
esac
`);
    chmodSync(curl, 0o755);
    const result = run({
      ...f.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc?request=1",
      GITGECKO_CLOUD_URL: "https://gitgecko.example",
    });
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(f.githubEnv, "utf8");
    assert.match(exported, /## Linked requirements/);
    assert.match(exported, /No expiry check appears in the diff/);
    assert.match(exported, /GITGECKO_REVIEW_EXIT_CODE=1/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Action runner suppresses credential-bearing OIDC failures", () => {
  const f = fixture();
  try {
    const result = run({
      ...f.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc?request=1",
      FAKE_OIDC_FAIL: "1",
      GITGECKO_CLOUD_URL: "https://gitgecko.example",
    });
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(f.githubEnv, "utf8");
    assert.match(exported, /GitHub OIDC token exchange failed/);
    assert.match(exported, /GITGECKO_REVIEW_EXIT_CODE=22/);
    assert.doesNotMatch(exported, /credential-bearing/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Action runner suppresses provider-bearing cloud transport failures", () => {
  const f = fixture();
  try {
    const result = run({
      ...f.env,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/oidc?request=1",
      FAKE_CLOUD_FAIL: "1",
      GITGECKO_CLOUD_URL: "https://gitgecko.example",
    });
    assert.equal(result.status, 0, result.stderr);
    const exported = readFileSync(f.githubEnv, "utf8");
    assert.match(exported, /GitGecko cloud review request failed/);
    assert.match(exported, /GITGECKO_REVIEW_EXIT_CODE=22/);
    assert.doesNotMatch(exported, /provider-internal/);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});
