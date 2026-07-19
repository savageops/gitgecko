import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createModels, fauxAssistantMessage, fauxProvider, type Context, type MutableModels } from "@earendil-works/pi-ai";
import { createProviderGenerate } from "./model-client.js";

describe("provider conversation fidelity", () => {
  it("preserves system, user, assistant, and tool-result roles in pi-ai context", async () => {
    const handle = fauxProvider({ provider: "roles-p", api: "roles-a" });
    const models: MutableModels = createModels();
    models.setProvider(handle.provider);
    let captured: Context | undefined;
    handle.setResponses([context => {
      captured = context;
      return fauxAssistantMessage("roles-ok");
    }]);
    const generate = createProviderGenerate(models, { providerId: "roles-p", apiId: "roles-a", modelId: handle.getModel().id });
    await generate("unused", undefined, { messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
      { role: "tool", content: "result", name: "read_file", toolCallId: "call_1" },
    ] });
    assert.equal(captured?.systemPrompt, "policy");
    assert.deepEqual(captured?.messages.map(message => message.role), ["user", "assistant", "toolResult"]);
    const toolResult = captured?.messages[2];
    assert.equal(toolResult?.role === "toolResult" ? toolResult.toolCallId : undefined, "call_1");
  });
});
