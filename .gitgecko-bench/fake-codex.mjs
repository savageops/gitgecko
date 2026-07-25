#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE || "normal";
const log = (entry) => fs.appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({
  at: new Date().toISOString(),
  mode,
  argv: args,
  cwd: process.cwd(),
  ...entry,
})}\n`);
const outputForMode = () => mode === "structured-error"
  ? "# Summary\nSynthetic native review.\n## Error\n- Native provider reported a blocker."
  : "# Summary\nSynthetic native review.\n## Warning\n- Native provider warning.";

log({ phase: "invoke" });
if (args[0] === "--version") {
  console.log("codex-cli 0.144.1");
  process.exit(0);
} else if (args[0] === "app-server" && args[1] === "generate-json-schema") {
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (!out) {
    process.stderr.write("missing --out");
    process.exit(2);
  }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "codex_app_server_protocol.schemas.json"), JSON.stringify({
    schemaVersion: "fake-codex-app-server.v1",
    methods: ["initialize", "thread/start", "thread/resume", "turn/start", "turn/interrupt"],
  }));
  log({ phase: "schema-generated", out });
  process.exit(0);
} else if (args[0] === "exec") {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { prompt += chunk; });
  process.stdin.on("end", () => {
    log({ phase: "exec", promptLength: prompt.length, promptPrefix: prompt.slice(0, 500) });
    if (mode === "timeout") {
      setTimeout(() => {}, 10_000);
      return;
    }
    if (mode === "exit-early") {
      process.stderr.write("synthetic early provider exit");
      process.exit(13);
    }
    if (mode === "auth-fail") {
      console.log(JSON.stringify({ type: "error", message: "401 Unauthorized: synthetic Codex login failure" }));
      return;
    }
    if (mode === "mutate") fs.writeFileSync("native-mutated-by-fake-codex.txt", "mutation occurred despite requested permission");
    console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-codex-thread" }));
    console.log(JSON.stringify({ type: "turn.started" }));
    if (mode === "malformed-lines") {
      console.log("this is not JSON");
      console.log("{also:not-json}");
    }
    if (mode !== "empty-output") {
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: outputForMode() } }));
    }
    console.log(JSON.stringify({ type: "turn.completed" }));
  });
} else if (args.length === 1 && args[0] === "app-server") {
  const lines = readline.createInterface({ input: process.stdin });
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const threadId = "fake-codex-thread";
  const turnId = "fake-codex-turn";
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    log({ phase: "rpc", message });
    if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake-codex/0.144.1" } });
    if (message.method === "initialized") return;
    if (message.method === "thread/start" || message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: threadId } } });
    if (message.method === "turn/start") {
      send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
      if (mode === "timeout") return;
      if (mode === "malformed-lines") return process.stdout.write("this is not JSON\n");
      if (mode === "auth-fail") return send({ method: "turn/completed", params: { turn: { id: turnId, status: "failed", error: { message: "401 Unauthorized: synthetic Codex login failure" } } } });
      if (mode !== "empty-output") send({ method: "item/completed", params: { item: { type: "agentMessage", text: outputForMode() } } });
      send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
      return;
    }
    if (message.method === "turn/interrupt") process.exit(0);
  });
} else {
  process.stderr.write(`unsupported fake Codex invocation: ${args.join(" ")}`);
  process.exit(2);
}
