#!/usr/bin/env bash
set -euo pipefail

export HOME="$RUNNER_TEMP/home"
export npm_config_cache="$RUNNER_TEMP/npm-cache"
mkdir -p "$HOME" "$RUNNER_TEMP/repo" "$RUNNER_TEMP/mock"

cat > "$RUNNER_TEMP/mock/server.mjs" <<'JS'
import http from 'node:http';
import fs from 'node:fs';
const port = 18765;
const logPath = process.env.MOCK_LOG;
const append = (value) => fs.appendFileSync(logPath, `${JSON.stringify(value)}\n`);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
  append({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body });

  if (req.method === 'GET' && (req.url === '/v1/models' || req.url === '/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{
      id: 'gitgecko-e2e-model', object: 'model', owned_by: 'local', name: 'GitGecko E2E Model',
      protocols: ['openai-chat-completions'], capabilities: { text: true, tools: false, reasoning: false, streaming: true }
    }] }));
    return;
  }

  if (req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions')) {
    const text = '[mock-model] Semantic review completed through the configured OpenAI-compatible endpoint.';
    const first = {
      id: 'chatcmpl-gitgecko-e2e', object: 'chat.completion.chunk', created: 1,
      model: 'gitgecko-e2e-model', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }]
    };
    const done = {
      id: 'chatcmpl-gitgecko-e2e', object: 'chat.completion.chunk', created: 1,
      model: 'gitgecko-e2e-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 }
    };
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.end(`data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `No mock route for ${req.method} ${req.url}` } }));
});
server.listen(port, '127.0.0.1', () => {
  fs.writeFileSync(process.env.MOCK_READY, 'ready');
});
JS

export MOCK_LOG="$RUNNER_TEMP/mock/requests.ndjson"
export MOCK_READY="$RUNNER_TEMP/mock/ready"
node "$RUNNER_TEMP/mock/server.mjs" > "$RUNNER_TEMP/mock/server.out" 2> "$RUNNER_TEMP/mock/server.err" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  test -f "$MOCK_READY" && break
  sleep 0.1
done
test -f "$MOCK_READY"

cd "$RUNNER_TEMP/repo"
git init -q
git config user.name "GitGecko E2E"
git config user.email "e2e@gitgecko.invalid"
printf 'export const safe = true;\n' > app.ts
git add app.ts
git commit -qm baseline
cat > app.ts <<'TS'
export function execute(expression: string): unknown {
  return eval(expression);
}
TS

run() {
  local name="$1"; shift
  set +e
  "$@" > "$RUNNER_TEMP/$name.out" 2> "$RUNNER_TEMP/$name.err"
  local code=$?
  set -e
  echo "$code" > "$RUNNER_TEMP/$name.code"
  printf '%s exit=%s stdout=%sB stderr=%sB\n' "$name" "$code" "$(wc -c < "$RUNNER_TEMP/$name.out")" "$(wc -c < "$RUNNER_TEMP/$name.err")"
  if test -s "$RUNNER_TEMP/$name.err"; then
    echo "--- $name stderr ---"
    cat "$RUNNER_TEMP/$name.err"
  fi
}

run configure npx --yes gitgecko models configure --base-url http://127.0.0.1:18765/v1 --model gitgecko-e2e-model --protocol openai-chat-completions
run show npx --yes gitgecko models show
run models npx --yes gitgecko models
run doctor npx --yes gitgecko doctor

for name in configure show models doctor; do
  echo "--- $name stdout ---"
  cat "$RUNNER_TEMP/$name.out"
done

run pi npx --yes gitgecko review --pathway pi --json
run auto npx --yes gitgecko review --pathway auto --json
run ask npx --yes gitgecko ask "Does the configured local route answer?" --pathway pi --json

node - <<'NODE'
const fs = require('node:fs');
const code = (name) => Number(fs.readFileSync(`${process.env.RUNNER_TEMP}/${name}.code`, 'utf8'));
for (const name of ['pi', 'auto', 'ask']) {
  const raw = fs.readFileSync(`${process.env.RUNNER_TEMP}/${name}.out`, 'utf8');
  let value;
  try { value = JSON.parse(raw); }
  catch (error) { throw new Error(`${name}: invalid JSON: ${error.message}\n${raw}`); }
  console.log(`${name}:`, JSON.stringify({
    exit: code(name), success: value.success, failure: value.failure,
    pathway: value.pathwayResolution, output: value.output,
    schema: value.artifact?.schemaVersion, mergeable: value.artifact?.mergeable,
    findings: value.artifact?.findings?.map((finding) => finding.ruleId),
  }));
  if (!value.success || value.pathwayResolution?.family !== 'local' || !value.output.includes('[mock-model]')) {
    throw new Error(`${name}: configured local model route failed`);
  }
  if (name !== 'ask') {
    if (code(name) !== 1 || value.artifact?.mergeable !== false || !value.artifact?.findings?.some((finding) => finding.ruleId === 'baseline-no-eval')) {
      throw new Error(`${name}: deterministic + model review contract failed`);
    }
  } else if (code(name) !== 0) {
    throw new Error('ask: expected exit 0');
  }
}
NODE

echo "--- mock requests ---"
cat "$MOCK_LOG"
node - <<'NODE'
const fs = require('node:fs');
const requests = fs.readFileSync(process.env.MOCK_LOG, 'utf8').trim().split('\n').map(JSON.parse);
const modelList = requests.find((request) => request.method === 'GET' && request.url.endsWith('/models'));
const completions = requests.filter((request) => request.method === 'POST' && request.url.endsWith('/chat/completions'));
if (!modelList) throw new Error('model discovery did not reach the configured endpoint');
if (completions.length !== 3) throw new Error(`expected 3 model calls, got ${completions.length}`);
if (completions.some((request) => request.authorization !== 'Bearer local')) throw new Error('local compatibility credential mismatch');
if (completions.some((request) => request.body?.model !== 'gitgecko-e2e-model')) throw new Error('configured model id not sent');
if (completions.some((request) => request.body?.stream !== true)) throw new Error('streaming contract not used');
NODE
