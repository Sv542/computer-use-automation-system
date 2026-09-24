import assert from "node:assert/strict";
import test from "node:test";
import type { DiscoverySpec } from "../src/domain/types.js";
import { GroqChatCompletionsProvider, type DecisionContext } from "../src/agent/model.js";

const spec: DiscoverySpec = {
  capability: { id: "test.capability", name: "Test capability", description: "Test Groq transport." },
  target: {
    surface: "web",
    appId: "test-app",
    entrypoint: "https://example.test/",
    allowedOrigins: ["https://example.test"],
    allowedPathPatterns: ["^/$"],
    redactSelectors: [],
  },
  compatibility: { vendorProduct: "Test", testedVersions: ["1"], uiFingerprint: "test" },
  contract: { inputs: {}, outputs: {}, businessOutcomes: [], goalTemplate: "Finish the test." },
  policy: { allowedActions: ["navigate", "click", "type", "extract"], irreversibleAction: "block", riskyTargetPatterns: [] },
  exceptionRules: [],
  checkpoint: { kind: "url_matches", pattern: "example\\.test" },
};

const context: DecisionContext = {
  goal: "Finish the test.",
  spec,
  inputs: {},
  observation: { url: "https://example.test/", title: "Test", frames: [] },
  completedActions: [],
  extractedOutputs: [],
  step: 1,
  maxSteps: 8,
};

test("Groq provider requests strict structured output and validates the response", async () => {
  let requestCount = 0;
  const request: typeof fetch = async (input, init) => {
    requestCount += 1;
    assert.equal(input, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(init?.method, "POST");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-key");

    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      reasoning_effort: string;
      include_reasoning: boolean;
      max_completion_tokens: number;
      response_format: { type: string; json_schema: { strict: boolean; schema: object } };
    };
    assert.equal(body.model, "openai/gpt-oss-20b");
    assert.equal(body.messages[0]?.role, "user");
    assert.match(body.messages[0]?.content ?? "", /Choose exactly one next UI action/);
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.include_reasoning, false);
    assert.equal(body.max_completion_tokens, 2_048);
    assert.equal(body.response_format.type, "json_schema");
    assert.equal(body.response_format.json_schema.strict, true);
    assert.ok(body.response_format.json_schema.schema);

    if (requestCount === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }

    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            kind: "finish",
            description: null,
            target: null,
            value: null,
            output: null,
            parseAs: null,
            risk: null,
            rationale: "The checkpoint is satisfied.",
            summary: "Finished.",
            reason: null,
          }),
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const provider = new GroqChatCompletionsProvider("openai/gpt-oss-20b", "test-key", request);
  assert.deepEqual(await provider.decide(context), {
    kind: "finish",
    summary: "Finished.",
    rationale: "The checkpoint is satisfied.",
  });
  assert.equal(requestCount, 2);
});

test("Groq provider requires an API key before discovery starts", () => {
  assert.throws(
    () => new GroqChatCompletionsProvider("openai/gpt-oss-20b", ""),
    /GROQ_API_KEY is required/,
  );
});

test("Groq provider safely normalizes omitted nullable envelope fields", async () => {
  const failedGeneration = JSON.stringify({
    kind: "type",
    description: "Enter member ID",
    target: {
      frame: { name: "main", urlPattern: null },
      locator: {
        strategy: "role",
        role: "textbox",
        name: "Member ID",
        label: null,
        text: null,
        selector: null,
        exact: null,
      },
    },
    value: { kind: "parameter", name: "memberId", value: null },
    parseAs: "string",
    risk: "safe",
    rationale: "Enter the required member ID.",
    summary: null,
    reason: null,
  });
  const request: typeof fetch = async () => new Response(JSON.stringify({
    error: {
      message: "Generated JSON does not match the expected schema.",
      type: "invalid_request_error",
      code: "json_validate_failed",
      failed_generation: failedGeneration,
    },
  }), { status: 400, headers: { "content-type": "application/json" } });

  const provider = new GroqChatCompletionsProvider("openai/gpt-oss-20b", "test-key", request);
  assert.deepEqual(await provider.decide(context), {
    kind: "type",
    description: "Enter member ID",
    target: {
      frame: { name: "main" },
      locator: { strategy: "role", role: "textbox", name: "Member ID" },
    },
    value: { kind: "parameter", name: "memberId" },
    risk: "safe",
    rationale: "Enter the required member ID.",
  });
});
