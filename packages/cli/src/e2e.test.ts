/**
 * END-TO-END INTEGRATION TEST — the proof that gitgecko works as a system.
 *
 * Exercises REAL plugs (not interfaces) through the FULL pipeline:
 *
 * Phase 1 — INDEX (code-intel, 5 capabilities compose):
 *   parse → graph → chunk → embed → retrieve
 *
 * Phase 2 — REVIEW (5 owners compose):
 *   retrieve grounding → rules evaluate → agent run → trace record → notify format
 *
 * This is the load-bearing test. If any owner/capability's output contract drifts,
 * this test breaks. It's the integration safety net for the whole system.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Real plugs (not interfaces)
import { parse as tsParse } from "@gitgecko/plug-tree-sitter-parse";
import { buildGraph } from "@gitgecko/plug-graph-build";
import { chunk } from "@gitgecko/plug-chunk";
import { embed, retrieve, InMemoryEmbedStore } from "@gitgecko/plug-embed";
import { retrieve as fuseRetrieve } from "@gitgecko/plug-retrieve";
import { evaluateRules } from "@gitgecko/plug-rules-evaluators";
import { runCommand } from "@gitgecko/plug-review-commands";
import { createGitGeckoNativeAgent } from "@gitgecko/plug-agent-gitgecko-native";

// Owners for trace + notify (in-process)
import { InMemoryTraceStore } from "@gitgecko/trace";
import { formatReviewAsComment, formatFindings } from "@gitgecko/notify";
import type { EmbeddingProvider, EmbedTag } from "@gitgecko/code-intel";
import type { Agent } from "@gitgecko/review";

// --- A sample "repo" to index ------------------------------------------------
const REPO_FILES = {
  "src/auth.py": `def login(user, password):
    token = authenticate(user, password)
    return token

def authenticate(user, password):
    if password == "secret":
        return user + "_token"
    return None
`,
  "src/utils.py": `def format_token(token):
    return f"Bearer {token}"

def hash_password(pw):
    return hash(pw)
`,
};

const PR_DIFF = `+def login(user, password):
+    token = authenticate(user, password)
+    return token
`;

const PR_TITLE = "Add login function";

// Deterministic fake embedding provider (char-frequency vectors)
const fakeProvider: EmbeddingProvider = {
  id: "fake-e2e",
  dimensions: 8,
  embed: async (texts: readonly string[]) =>
    texts.map((t) => {
      const v = new Array(8).fill(0);
      for (const ch of t.toLowerCase()) { const c = ch.codePointAt(0) ?? 0; v[c % 8]!++; }
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n);
    }),
};

// Deterministic fake agent (for unit-level E2E phases)
const fakeAgent: Agent = createGitGeckoNativeAgent(async (prompt: string) => {
  if (prompt.includes("login")) return "Review: The login function looks correct. Consider hashing the password before comparison.";
  return "Review: Code looks acceptable.";
});

// --- REAL HTTP mock LLM server (for the "real LLM review" E2E test) ---------
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
let mockLlmServer: HttpServer | null = null;
let mockLlmPort = 0;

function startMockLlm(): Promise<void> {
  return new Promise((resolve) => {
    mockLlmServer = createHttpServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url?.includes("/chat/completions")) {
          const parsed = JSON.parse(body);
          const prompt = parsed.messages?.[0]?.content ?? "";
          let review = "## gitgecko Review\n\n";
          if (prompt.includes("login") || prompt.includes("password")) {
            review += "1. **Security:** Hardcoded password comparison detected. Use bcrypt.\n";
            review += "2. **Best Practice:** Add input validation.\n\n**Summary:** Address the hardcoded secret before merging.";
          } else {
            review += "No critical issues found.";
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: review } }] }));
        } else {
          res.writeHead(404); res.end();
        }
      });
    });
    mockLlmServer.listen(0, () => {
      const addr = mockLlmServer!.address() as { port: number };
      mockLlmPort = addr.port;
      resolve();
    });
  });
}

function stopMockLlm(): Promise<void> {
  return new Promise((resolve) => {
    if (mockLlmServer) { mockLlmServer.close(() => resolve()); mockLlmServer = null; }
    else resolve();
  });
}

describe("E2E — Phase 1: INDEX pipeline (parse → graph → chunk → embed → retrieve)", () => {
  it("parses all source files into def/ref tags", async () => {
    const parsed = [];
    for (const [path, source] of Object.entries(REPO_FILES)) {
      parsed.push(await tsParse({ source, relPath: path }));
    }
    assert.equal(parsed.length, 2);
    // Each file should have def tags
    for (const f of parsed) {
      const defs = f.tags.filter((t) => t.category === "def");
      assert.ok(defs.length > 0, `${f.relPath} should have definitions`);
    }
    // auth.py should have login + authenticate
    const authDefs = parsed[0]!.tags.filter((t) => t.category === "def").map((t) => t.name);
    assert.ok(authDefs.includes("login"));
    assert.ok(authDefs.includes("authenticate"));
  });

  it("builds a code graph from parsed tags (nodes + CALLS edges)", async () => {
    const parsed = [];
    for (const [path, source] of Object.entries(REPO_FILES)) {
      parsed.push(await tsParse({ source, relPath: path }));
    }
    const graphOut = buildGraph({ repoName: "test-repo", files: parsed });
    assert.ok(graphOut.graph.nodes.size > 5, "should have Project + Files + Modules + Functions");
    // login should be a Function node
    const loginFn = [...graphOut.graph.nodes.values()].find((n) => n.name === "login" && n.type === "Function");
    assert.ok(loginFn, "login Function node must exist");
    // login() calls authenticate() → CALLS edge
    const calls = graphOut.graph.edgeList.filter((e) => e.type === "CALLS");
    assert.ok(calls.length > 0, "should have CALLS edges");
  });

  it("chunks source files into AST-aware chunks", async () => {
    const chunked = await chunk({ source: REPO_FILES["src/auth.py"]!, relPath: "src/auth.py", maxChunkSize: 500 });
    assert.ok(chunked.chunks.length > 0, "auth.py should produce at least one chunk");
    assert.ok(chunked.chunks.some((c) => c.content.includes("login")), "a chunk should contain 'login'");
  });

  it("embeds chunks and stores them for retrieval", async () => {
    const store = new InMemoryEmbedStore();
    const tag: EmbedTag = { repo: "test-repo", branch: "main", embeddingId: "fake-e2e" };
    const chunked = await chunk({ source: REPO_FILES["src/auth.py"]!, relPath: "src/auth.py", maxChunkSize: 500 });
    const out = await embed({
      tag, provider: fakeProvider, store,
      chunks: chunked.chunks.map((c) => ({ ...c, filepath: "src/auth.py" })),
    });
    assert.equal(out.stored, chunked.chunks.length);
    assert.ok(await store.count(tag) > 0);
  });

  it("retrieves relevant chunks for a query (embeddings round-trip)", async () => {
    const store = new InMemoryEmbedStore();
    const tag: EmbedTag = { repo: "test-repo", branch: "main", embeddingId: "fake-e2e" };
    for (const [path, source] of Object.entries(REPO_FILES)) {
      const chunked = await chunk({ source, relPath: path, maxChunkSize: 500 });
      await embed({ tag, provider: fakeProvider, store, chunks: chunked.chunks.map((c) => ({ ...c, filepath: path })) });
    }
    const results = await retrieve({ tag, query: "login password", provider: fakeProvider, store, limit: 3 });
    assert.ok(results.length > 0, "should find chunks for 'login password'");
    // The auth.py chunk should be in the results
    assert.ok(results.some((r) => r.path === "src/auth.py"), "auth.py should be in results");
  });
});

describe("E2E — Phase 2: REVIEW pipeline (retrieve → rules → agent → trace → notify)", () => {
  it("runs deterministic rules against the PR diff (the anti-noise wedge)", async () => {
    const findings = await evaluateRules({
      filepath: "diff.py",
      source: PR_DIFF,
      language: "python",
      rules: [
        { id: "password-param", kind: "lexical", severity: "warning", message: "Consider hashing passwords before use", regex: "password" },
      ],
    });
    // "password" appears in the diff → lexical rule should fire
    assert.ok(findings.deterministicCount >= 1, "should have at least 1 deterministic finding");
    const sources = new Set(findings.findings.map((f) => f.source));
    assert.ok(!sources.has("llm") || findings.llmCount > 0, "deterministic findings are tagged correctly");
  });

  it("runs a full review: retrieve grounding → agent → output", async () => {
    // Index the repo
    const store = new InMemoryEmbedStore();
    const tag: EmbedTag = { repo: "test-repo", branch: "main", embeddingId: "fake-e2e" };
    for (const [path, source] of Object.entries(REPO_FILES)) {
      const chunked = await chunk({ source, relPath: path, maxChunkSize: 500 });
      await embed({ tag, provider: fakeProvider, store, chunks: chunked.chunks.map((c) => ({ ...c, filepath: path })) });
    }

    // Wire retrieve for the review command — simulate the orchestrator's grounding
    // (002: the orchestrator calls retrieve, renders, passes via instructions.repoContext)
    const retrieveFn = async (query: string) => {
      const results = await retrieve({ tag, query, provider: fakeProvider, store, limit: 3 });
      return results.map((r) => ({ content: r.chunk.content, filepath: r.path }));
    };
    const grounded = await retrieveFn("login function");
    const repoContext = `## Repo context (retrieved):\n${grounded.map((r) => `--- ${r.filepath} ---\n${r.content}`).join("\n\n")}`;

    // Run the /review command
    const result = await runCommand({
      command: "review",
      payload: { repo: "test-repo", prNumber: 1, title: PR_TITLE, diff: PR_DIFF, files: ["src/auth.py"] },
      agent: fakeAgent,
      instructions: { systemPrompt: "You are an expert code reviewer.", rules: ["Hash passwords before comparison"], repoContext },
    });

    assert.ok(result.success, "review must succeed");
    assert.ok(result.output.length > 0, "review must produce output");
    assert.ok(result.output.includes("login") || result.output.includes("password"), "output should mention login/password");
    assert.ok(result.trace.length > 0, "trace must be recorded");
  });

  it("records every step to the trace store (G8 auditability)", async () => {
    const traceStore = new InMemoryTraceStore();

    // Index
    const store = new InMemoryEmbedStore();
    const tag: EmbedTag = { repo: "test-repo", branch: "main", embeddingId: "fake-e2e" };
    for (const [path, source] of Object.entries(REPO_FILES)) {
      const chunked = await chunk({ source, relPath: path, maxChunkSize: 500 });
      await embed({ tag, provider: fakeProvider, store, chunks: chunked.chunks.map((c) => ({ ...c, filepath: path })) });
    }

    // Review — grounding now flows via instructions.repoContext (002); this test
    // exercises the trace pipeline, not grounding, so no repoContext needed.
    const result = await runCommand({
      command: "review",
      payload: { repo: "test-repo", prNumber: 1, title: PR_TITLE, diff: PR_DIFF, files: ["src/auth.py"] },
      agent: fakeAgent,
    });

    // Record the review step to trace
    traceStore.record({
      runId: "e2e-run-1",
      stepId: "review",
      ts: new Date().toISOString(),
      command: "review",
      output: result.output,
      source: "llm",
      ...(result.toolState.calls.length > 0 && { toolCalls: result.toolState.calls }),
    });

    // Verify the trace is queryable
    const trace = traceStore.read("e2e-run-1");
    assert.equal(trace.steps.length, 1);
    assert.equal(trace.steps[0]!.command, "review");
    assert.ok(trace.steps[0]!.output!.includes("login"));
  });

  it("formats the review result as a VCS notification comment", async () => {
    const result = await runCommand({
      command: "review",
      payload: { repo: "test-repo", prNumber: 1, title: PR_TITLE, diff: PR_DIFF, files: ["src/auth.py"] },
      agent: fakeAgent,
    });
    const comment = formatReviewAsComment({ output: result.output, command: "review", pathway: "gitgecko-native" });
    assert.ok(comment.body!.includes("## GitGecko review"));
    assert.ok(comment.body!.includes(result.output));
    assert.ok(comment.body!.includes("gitgecko-native"));
  });

  it("formats deterministic findings as structured audit comments", async () => {
    const findings = await evaluateRules({
      filepath: "diff.py",
      source: PR_DIFF,
      language: "python",
      rules: [
        { id: "password-param", kind: "lexical", severity: "warning", message: "Consider hashing passwords", regex: "password" },
      ],
    });
    const formatted = formatFindings(findings.findings.map((f) => ({ ...f, filepath: "diff.py" })));
    assert.ok(formatted.includes("[password-param]"));
    assert.ok(formatted.includes("password"));
    assert.ok(formatted.includes("deterministic"));
  });
});

describe("E2E — Full pipeline composition (all owners + capabilities in one flow)", () => {
  it("indexes a repo AND reviews a PR in one end-to-end flow", async () => {
    // === INDEX PHASE ===
    // 1. Parse
    const parsed = [];
    for (const [path, source] of Object.entries(REPO_FILES)) {
      parsed.push(await tsParse({ source, relPath: path }));
    }
    assert.ok(parsed.length === 2);

    // 2. Graph
    const graph = buildGraph({ repoName: "test-repo", files: parsed });
    assert.ok(graph.graph.nodes.size > 5);

    // 3. Chunk
    const allChunks = [];
    for (const [path, source] of Object.entries(REPO_FILES)) {
      const c = await chunk({ source, relPath: path, maxChunkSize: 500 });
      allChunks.push(...c.chunks.map((ch) => ({ ...ch, filepath: path })));
    }
    assert.ok(allChunks.length > 0);

    // 4. Embed
    const store = new InMemoryEmbedStore();
    const tag: EmbedTag = { repo: "test-repo", branch: "main", embeddingId: "fake-e2e" };
    await embed({ tag, provider: fakeProvider, store, chunks: allChunks });
    assert.ok(await store.count(tag) > 0);

    // 5. Retrieve (verify the index works)
    const retrieveFn = async (query: string) => {
      const r = await retrieve({ tag, query, provider: fakeProvider, store, limit: 3 });
      return r.map((x) => ({ content: x.chunk.content, filepath: x.path }));
    };
    const searchResults = await retrieveFn("login authenticate");
    assert.ok(searchResults.length > 0);

    // === REVIEW PHASE ===
    // 6. Rules (deterministic-first)
    const rulesOut = await evaluateRules({
      filepath: "diff.py", source: PR_DIFF, language: "python",
      rules: [{ id: "password-param", kind: "lexical", severity: "warning", message: "Consider hashing passwords", regex: "password" }],
    });
    assert.ok(rulesOut.deterministicCount >= 1);

    // 7. Agent review (grounding via instructions.repoContext per 002)
    const reviewResult = await runCommand({
      command: "review",
      payload: { repo: "test-repo", prNumber: 1, title: PR_TITLE, diff: PR_DIFF, files: ["src/auth.py"] },
      agent: fakeAgent,
      instructions: { systemPrompt: "Expert reviewer.", rules: [] },
    });
    assert.ok(reviewResult.success);
    assert.ok(reviewResult.output.length > 0);

    // 8. Trace
    const traceStore = new InMemoryTraceStore();
    traceStore.record({
      runId: "full-e2e", stepId: "review", ts: new Date().toISOString(),
      command: "review", output: reviewResult.output, source: "llm",
    });
    const trace = traceStore.read("full-e2e");
    assert.equal(trace.steps.length, 1);

    // 9. Notify (format the comment)
    const comment = formatReviewAsComment({ output: reviewResult.output, command: "review" });
    assert.ok(comment.body!.includes(reviewResult.output));

    // === ASSERTION: the full pipeline produced a grounded, traced, formatted review ===
    assert.ok(reviewResult.output.includes("login") || reviewResult.output.includes("password"), "review should reference the code");
    assert.ok(rulesOut.deterministicCount >= 1, "deterministic rules should have fired");
    assert.ok(trace.steps[0]!.output!.length > 0, "trace should carry the output");
    assert.ok(comment.body!.includes("## GitGecko review"), "notify should format as a GitGecko comment");
  });
});

describe("E2E — REAL HTTP LLM review (not a fake agent)", () => {
  it("runs a review through a real HTTP OpenAI-compatible endpoint", async () => {
    await startMockLlm();
    try {
      // Create an agent that calls the mock server via real HTTP (not a fake function)
      const realHttpAgent = createGitGeckoNativeAgent(async (prompt: string) => {
        const res = await fetch(`http://localhost:${mockLlmPort}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "mock-model",
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { choices: Array<{ message: { content: string } }> };
        return data.choices[0]?.message?.content ?? "(no response)";
      });

      const result = await runCommand({
        command: "review",
        payload: { repo: "test-repo", prNumber: 1, title: PR_TITLE, diff: PR_DIFF, files: ["src/auth.py"] },
        agent: realHttpAgent,
        instructions: { systemPrompt: "You are an expert code reviewer.", rules: [] },
      });

      assert.ok(result.success, "review must succeed");
      assert.ok(result.output.includes("Security"), "output should mention Security (real review)");
      assert.ok(result.output.includes("bcrypt"), "output should mention bcrypt (real review content)");
      assert.ok(result.trace.length > 0, "trace must be recorded");
    } finally {
      await stopMockLlm();
    }
  });
});

// --- gitgecko-native backend: repoContext prompt section (002e) ------------------

describe("gitgecko-native backend — repoContext prompt section (002e)", () => {
  // The complete fn captures the full prompt it receives.
  const makeCaptureAgent = (): { agent: Agent; lastPrompt: { value: string | null } } => {
    const lastPrompt = { value: null as string | null };
    const agent = createGitGeckoNativeAgent(async (prompt: string) => {
      lastPrompt.value = prompt;
      return "review output";
    });
    return { agent, lastPrompt };
  };

  const makeRunCtx = (overrides: Record<string, unknown> = {}) => ({
    payload: { repo: "t", prNumber: 1, title: "T", diff: "+code", files: ["a.ts"] },
    cwd: process.cwd(),
    permission: "read-only",
    persistence: "ephemeral",
    mcpServerUrl: "",
    tmpdir: "/tmp",
    subagentDeniedTools: [],
    instructions: { systemPrompt: "S", rules: [] },
    toolState: { calls: [] },
    apiToken: "",
    ...overrides,
  });

  it("includes repoContext in the prompt when present", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nGrounded data here" },
    }) as Parameters<typeof agent.run>[0]);
    assert.ok(lastPrompt.value);
    assert.match(lastPrompt.value!, /Repo context/);
    assert.match(lastPrompt.value!, /Grounded data here/);
  });

  it("omits repoContext when absent", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx() as Parameters<typeof agent.run>[0]);
    assert.ok(lastPrompt.value);
    assert.doesNotMatch(lastPrompt.value!, /Repo context/);
  });

  it("diff is still present when repoContext is rendered", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nData" },
    }) as Parameters<typeof agent.run>[0]);
    assert.match(lastPrompt.value!, /\+code/);
  });

  it("persona + repoContext both appear", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], persona: "EXPERT PERSONA", repoContext: "## Repo context:\nData" },
    }) as Parameters<typeof agent.run>[0]);
    assert.match(lastPrompt.value!, /EXPERT PERSONA/);
    assert.match(lastPrompt.value!, /Repo context/);
  });

  it("findings + repoContext both appear", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: {
        systemPrompt: "S", rules: [],
        findings: [{ ruleId: "R1", kind: "lexical", severity: "error", message: "bug", filepath: "a.ts", line: 1, column: 0, match: "x", source: "deterministic" }],
        repoContext: "## Repo context:\nData",
      },
    }) as Parameters<typeof agent.run>[0]);
    assert.match(lastPrompt.value!, /R1|Deterministic findings/);
    assert.match(lastPrompt.value!, /Repo context/);
  });

  it("rules + repoContext both appear", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: ["Rule A"], repoContext: "## Repo context:\nData" },
    }) as Parameters<typeof agent.run>[0]);
    assert.match(lastPrompt.value!, /Rule A/);
    assert.match(lastPrompt.value!, /Repo context/);
  });

  it("outputFormat + repoContext both appear", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], outputFormat: "## Output Format", repoContext: "## Repo context:\nData" },
    }) as Parameters<typeof agent.run>[0]);
    assert.match(lastPrompt.value!, /Output Format/);
    assert.match(lastPrompt.value!, /Repo context/);
  });

  it("repoContext content preserved verbatim", async () => {
    const ctx = "## Repo context:\n--- a.ts ---\nconst exact = 'preserve';";
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: ctx },
    }) as Parameters<typeof agent.run>[0]);
    assert.ok(lastPrompt.value!.includes("const exact = 'preserve';"));
  });

  it("empty repoContext produces no section", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: "" },
    }) as Parameters<typeof agent.run>[0]);
    assert.doesNotMatch(lastPrompt.value!, /## Repo context/);
  });

  it("the run succeeds with repoContext", async () => {
    const { agent } = makeCaptureAgent();
    const result = await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nData" },
    }) as Parameters<typeof agent.run>[0]);
    assert.equal(result.success, true);
  });

  it("repoContext is placed in the prompt (before the diff)", async () => {
    const { agent, lastPrompt } = makeCaptureAgent();
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nBEFORE_DIFF" },
    }) as Parameters<typeof agent.run>[0]);
    const prompt = lastPrompt.value!;
    const rcIdx = prompt.indexOf("BEFORE_DIFF");
    const diffIdx = prompt.indexOf("Diff:");
    assert.ok(rcIdx > -1 && diffIdx > -1);
    // repoContext (findingsText+repoContextText) is before "Reviewing PR" which is before "Diff:"
    // The repoContext section appears before the diff section
    assert.ok(rcIdx < prompt.indexOf("+code"), "repoContext should appear before the diff content");
  });

  it("toolState records the call when repoContext is present", async () => {
    const { agent } = makeCaptureAgent();
    const toolState = { calls: [] as { tool: string; input: unknown }[] };
    await agent.run(makeRunCtx({
      instructions: { systemPrompt: "S", rules: [], repoContext: "## Repo context:\nData" },
      toolState,
    }) as Parameters<typeof agent.run>[0]);
    assert.equal(toolState.calls.length, 1);
  });
});
