import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverRepositoryRules, renderRepositoryRules } from "./repository-rules.js";

const withRepository = (files: Readonly<Record<string, string>>, run: (root: string) => void): void => {
  const root = join(tmpdir(), `gitgecko-repository-rules-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(root, ".git"), { recursive: true });
  try {
    for (const [path, content] of Object.entries(files)) {
      const destination = join(root, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const diffFor = (path: string): string => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@\n+const changed = true;`;

describe("repository rule discovery", () => {
  it("loads a root AGENTS.md for a changed repository file", () => {
    withRepository({ "AGENTS.md": "Root rule", "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.deepEqual(result.rules.map((rule) => rule.path), ["AGENTS.md"]);
      assert.equal(result.rules[0]?.instruction, "Root rule");
    });
  });

  it("loads nested guidelines after broader guidelines", () => {
    withRepository({ "AGENTS.md": "Root rule", "src/AGENTS.md": "Source rule", "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.deepEqual(result.rules.map((rule) => rule.path), ["AGENTS.md", "src/AGENTS.md"]);
    });
  });

  it("does not lose scoped rules behind a large unrelated file inventory", () => {
    const files: Record<string, string> = { "AGENTS.md": "Root rule", "src/feature/AGENTS.md": "Feature rule" };
    for (let index = 0; index < 300; index += 1) files[`aaa/filler-${index.toString().padStart(3, "0")}.ts`] = "export {};";
    withRepository(files, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/feature/app.ts"));
      assert.deepEqual(result.rules.map((rule) => rule.path), ["AGENTS.md", "src/feature/AGENTS.md"]);
    });
  });

  it("does not apply a nested guideline to an unrelated changed path", () => {
    withRepository({ "src/AGENTS.md": "Source rule", "docs/readme.md": "# Docs" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("docs/readme.md"));
      assert.deepEqual(result.rules, []);
    });
  });

  it("discovers each common agent-guideline filename", () => {
    const filenames = ["AGENT.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules"];
    for (const filename of filenames) {
      withRepository({ [filename]: filename, "src/app.ts": "export {};" }, (root) => {
        const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
        assert.equal(result.rules[0]?.path, filename);
      });
    }
  });

  it("discovers Cursor rule directories", () => {
    withRepository({ ".cursor/rules/types.md": "Cursor rule", "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.equal(result.rules[0]?.path, ".cursor/rules/types.md");
    });
  });

  it("discovers generic .rules directories", () => {
    withRepository({ ".rules/security.md": "Security rule", "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.equal(result.rules[0]?.path, ".rules/security.md");
    });
  });

  it("loads the root Copilot instruction file for all changed paths", () => {
    withRepository({ ".github/copilot-instructions.md": "Copilot rule", "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.equal(result.rules[0]?.path, ".github/copilot-instructions.md");
    });
  });

  it("loads custom guideline patterns from .coderabbit.yaml", () => {
    withRepository({
      ".coderabbit.yaml": "knowledge_base:\n  code_guidelines:\n    filePatterns:\n      - docs/STYLE.md\n",
      "docs/STYLE.md": "Style rule",
      "src/app.ts": "export {};",
    }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.equal(result.rules[0]?.path, "docs/STYLE.md");
    });
  });

  it("adds matching .coderabbit.yaml path instructions after guideline files", () => {
    withRepository({
      "AGENTS.md": "Root rule",
      ".coderabbit.yaml": "reviews:\n  path_instructions:\n    - path: src/**\n      instructions: Require an explicit boundary test.\n",
      "src/app.ts": "export {};",
    }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.deepEqual(result.rules.map((rule) => rule.source), ["guideline", "path-instruction"]);
      assert.equal(result.rules[1]?.instruction, "Require an explicit boundary test.");
    });
  });

  it("does not load unmatched .coderabbit.yaml path instructions", () => {
    withRepository({
      ".coderabbit.yaml": "reviews:\n  path_instructions:\n    - path: docs/**\n      instructions: Docs rule\n",
      "src/app.ts": "export {};",
    }, (root) => {
      assert.deepEqual(discoverRepositoryRules(root, diffFor("src/app.ts")).rules, []);
    });
  });

  it("accepts several changed paths when selecting a path instruction", () => {
    withRepository({
      ".coderabbit.yaml": "reviews:\n  path_instructions:\n    - path: api/**\n      instructions: API rule\n",
      "src/app.ts": "export {};",
      "api/route.ts": "export {};",
    }, (root) => {
      const diff = `${diffFor("src/app.ts")}\n${diffFor("api/route.ts")}`;
      assert.equal(discoverRepositoryRules(root, diff).rules[0]?.instruction, "API rule");
    });
  });

  it("reports malformed .coderabbit.yaml without aborting the review", () => {
    withRepository({ ".coderabbit.yaml": "reviews: [", "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.deepEqual(result.rules, []);
      assert.deepEqual(result.diagnostics, ["Ignored malformed .coderabbit.yaml."]);
    });
  });

  it("does not read oversized rule files into a provider prompt", () => {
    withRepository({ "AGENTS.md": "x".repeat(24 * 1024 + 1), "src/app.ts": "export {};" }, (root) => {
      const result = discoverRepositoryRules(root, diffFor("src/app.ts"));
      assert.deepEqual(result.rules, []);
      assert.match(result.diagnostics[0] ?? "", /oversized repository rule file: AGENTS\.md/);
    });
  });

  it("uses only root-scope rules when the diff has no file headers", () => {
    withRepository({ "AGENTS.md": "Root rule", "src/AGENTS.md": "Source rule" }, (root) => {
      const result = discoverRepositoryRules(root, "+const unknown = true;");
      assert.deepEqual(result.rules.map((rule) => rule.path), ["AGENTS.md"]);
    });
  });

  it("returns the target directory as root when no .git boundary exists", () => {
    const root = join(tmpdir(), `gitgecko-repository-rules-no-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    try {
      writeFileSync(join(root, "AGENTS.md"), "Root rule");
      assert.equal(discoverRepositoryRules(root, diffFor("src/app.ts")).root, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders source provenance and scoped path instructions", () => {
    const rendered = renderRepositoryRules([
      { path: "AGENTS.md", scope: "", instruction: "Root rule", source: "guideline" },
      { path: ".coderabbit.yaml", scope: "src/**", instruction: "Source rule", source: "path-instruction" },
    ]);
    assert.deepEqual(rendered, ["[repository:AGENTS.md] Root rule", "[repository:.coderabbit.yaml (src/**)] Source rule"]);
  });
});
