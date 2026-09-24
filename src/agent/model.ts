import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { DiscoverySpec, JsonValue, ModelAction, SurfaceObservation } from "../domain/types.js";

export interface DecisionContext {
  goal: string;
  spec: DiscoverySpec;
  inputs: Record<string, JsonValue>;
  observation: SurfaceObservation;
  completedActions: Array<{ kind: string; description: string }>;
  extractedOutputs: string[];
  step: number;
  maxSteps: number;
}

export interface ModelProvider {
  readonly id: string;
  readonly model: string;
  decide(context: DecisionContext): Promise<ModelAction>;
}

const schemaUrl = new URL("../../schema/model-action.schema.json", import.meta.url);
const modelSchema = JSON.parse(await readFile(schemaUrl, "utf8")) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
const validateDecision = ajv.compile(modelSchema);

interface DecisionEnvelope {
  kind: "click" | "type" | "extract" | "finish" | "escalate";
  description: string | null;
  target: {
    frame: { name: string | null; urlPattern: string | null } | null;
    locator: {
      strategy: "role" | "label" | "text" | "css";
      role: string | null;
      name: string | null;
      label: string | null;
      text: string | null;
      selector: string | null;
      exact: boolean | null;
    };
  } | null;
  value: { kind: "literal" | "parameter"; value: string | null; name: string | null } | null;
  output: string | null;
  parseAs: "string" | "integer" | "number" | "boolean" | "money" | null;
  risk: "safe" | "reversible" | "irreversible" | null;
  rationale: string;
  summary: string | null;
  reason: string | null;
}

function required<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`Model action is missing required field: ${field}`);
  return value;
}

function assertDecision(value: unknown): ModelAction {
  if (!validateDecision(value)) {
    throw new Error(`Model returned an invalid action: ${ajv.errorsText(validateDecision.errors)}`);
  }
  const envelope = value as DecisionEnvelope;
  if (envelope.kind === "finish") {
    return { kind: "finish", summary: required(envelope.summary, "summary"), rationale: envelope.rationale };
  }
  if (envelope.kind === "escalate") {
    return { kind: "escalate", reason: required(envelope.reason, "reason"), rationale: envelope.rationale };
  }

  const rawTarget = required(envelope.target, "target");
  const rawLocator = rawTarget.locator;
  const locator = (() => {
    switch (rawLocator.strategy) {
      case "role":
        return {
          strategy: "role" as const,
          role: required(rawLocator.role, "target.locator.role"),
          name: required(rawLocator.name, "target.locator.name"),
          ...(rawLocator.exact === null ? {} : { exact: rawLocator.exact }),
        };
      case "label":
        return {
          strategy: "label" as const,
          label: required(rawLocator.label, "target.locator.label"),
          ...(rawLocator.exact === null ? {} : { exact: rawLocator.exact }),
        };
      case "text":
        return {
          strategy: "text" as const,
          text: required(rawLocator.text, "target.locator.text"),
          ...(rawLocator.exact === null ? {} : { exact: rawLocator.exact }),
        };
      case "css":
        return { strategy: "css" as const, selector: required(rawLocator.selector, "target.locator.selector") };
    }
  })();
  const rawFrame = rawTarget.frame;
  const frame = rawFrame
    ? {
        ...(rawFrame.name ? { name: rawFrame.name } : {}),
        ...(rawFrame.urlPattern ? { urlPattern: rawFrame.urlPattern } : {}),
      }
    : undefined;
  const target = { ...(frame && Object.keys(frame).length > 0 ? { frame } : {}), locator };
  const fallbackDescription = envelope.kind === "type" && envelope.value?.kind === "parameter" && envelope.value.name
    ? `Enter the ${envelope.value.name} input`
    : envelope.kind === "click"
      ? "Activate the selected control"
      : envelope.output
        ? `Extract ${envelope.output}`
        : "Extract the declared output";
  const base = {
    description: envelope.description ?? fallbackDescription,
    target,
    risk: required(envelope.risk, "risk"),
    rationale: envelope.rationale,
  };
  if (envelope.kind === "click") return { kind: "click", ...base };
  if (envelope.kind === "type") {
    const rawValue = required(envelope.value, "value");
    const typedValue = rawValue.kind === "parameter"
      ? { kind: "parameter" as const, name: required(rawValue.name, "value.name") }
      : { kind: "literal" as const, value: required(rawValue.value, "value.value") };
    return { kind: "type", ...base, value: typedValue };
  }
  return {
    kind: "extract",
    ...base,
    output: required(envelope.output, "output"),
    parseAs: required(envelope.parseAs, "parseAs"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addMissingNulls(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const normalized = { ...record };
  for (const key of keys) {
    if (!Object.hasOwn(normalized, key)) normalized[key] = null;
  }
  return normalized;
}

function normalizeDecisionEnvelope(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const normalized = addMissingNulls(value, [
    "description", "target", "value", "output", "parseAs", "risk", "summary", "reason",
  ]);

  if (isRecord(normalized.target)) {
    const target = { ...normalized.target };
    if (isRecord(target.frame)) target.frame = addMissingNulls(target.frame, ["name", "urlPattern"]);
    if (isRecord(target.locator)) {
      target.locator = addMissingNulls(target.locator, ["role", "name", "label", "text", "selector", "exact"]);
    }
    normalized.target = target;
  }
  if (isRecord(normalized.value)) normalized.value = addMissingNulls(normalized.value, ["value", "name"]);
  return normalized;
}

function parseDecisionCandidate(text: string): ModelAction {
  return assertDecision(normalizeDecisionEnvelope(JSON.parse(text)));
}

function buildPrompt(context: DecisionContext): string {
  return `You are the discovery planner for a policy-constrained computer-use system.
Choose exactly one next UI action from the supplied observation. Return only the JSON object required by the response schema.
The schema is a fixed envelope: include every key and use null for fields that do not apply to the selected kind.

Rules:
- Work only toward the stated goal. Never invent controls not present in the observation.
- Prefer role/name or label locators. Use CSS only if no semantic target exists.
- For values supplied by the caller, use {"kind":"parameter","name":"..."}; never copy the literal into the action.
- Never include a caller-supplied literal in description or rationale; refer to its parameter name instead.
- Extract only outputs declared by the contract, using the exact output key.
- Never extract an output already listed in Extracted outputs. If every output is extracted and the checkpoint is visible, return finish.
- Mark irreversible actions accurately. Search, typing into a lookup form, reading, and navigation are safe.
- Return finish only after all required outputs are extracted and the visible state satisfies the checkpoint.
- Return escalate if the current state requires judgment or safe progress is impossible.
- rationale is a brief decision summary, not private chain-of-thought.
- Before returning, verify these top-level keys are all present: kind, description, target, value, output, parseAs, risk, rationale, summary, reason.
- Never omit an inapplicable key. Set it to null; for example, a type action has output: null and parseAs: null.

Goal: ${context.goal}
Step: ${context.step} of ${context.maxSteps}
Input contract: ${JSON.stringify(context.spec.contract.inputs)}
Output contract: ${JSON.stringify(context.spec.contract.outputs)}
Checkpoint: ${JSON.stringify(context.spec.checkpoint)}
Completed actions: ${JSON.stringify(context.completedActions)}
Extracted outputs: ${JSON.stringify(context.extractedOutputs)}
Current observation: ${JSON.stringify(context.observation)}`;
}

type FetchImplementation = typeof fetch;

function retryAfterMilliseconds(response: Response): number {
  const value = response.headers.get("retry-after");
  if (!value) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1_000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.min(60_000, Math.max(0, timestamp - Date.now())) : 1_000;
}

export class GroqChatCompletionsProvider implements ModelProvider {
  readonly id = "groq-chat-completions";

  constructor(
    readonly model = process.env.GROQ_MODEL ?? "openai/gpt-oss-20b",
    private readonly apiKey = process.env.GROQ_API_KEY,
    private readonly request: FetchImplementation = fetch,
  ) {
    if (!apiKey) throw new Error("GROQ_API_KEY is required for the Groq provider.");
  }

  async decide(context: DecisionContext): Promise<ModelAction> {
    const requestOptions: RequestInit = {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: buildPrompt(context) }],
        temperature: 0,
        reasoning_effort: "low",
        include_reasoning: false,
        max_completion_tokens: 2_048,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "computer_use_action",
            strict: true,
            schema: modelSchema,
          },
        },
      }),
    };
    let response = await this.request("https://api.groq.com/openai/v1/chat/completions", requestOptions);
    if (response.status === 429) {
      const retryDelay = retryAfterMilliseconds(response);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      response = await this.request("https://api.groq.com/openai/v1/chat/completions", requestOptions);
    }
    if (!response.ok) {
      const errorText = await response.text();
      let errorBody: {
        error?: { message?: string; code?: string; failed_generation?: string };
      } | undefined;
      try {
        errorBody = JSON.parse(errorText) as typeof errorBody;
      } catch {
        // Keep the original response text for non-JSON upstream failures.
      }
      const failure = errorBody?.error;
      if (response.status === 400 && failure?.code === "json_validate_failed" && failure.failed_generation) {
        try {
          return parseDecisionCandidate(failure.failed_generation);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`Groq returned an invalid structured candidate that could not be safely normalized: ${reason}`);
        }
      }
      throw new Error(`Groq Chat Completions failed (${response.status}): ${failure?.message ?? errorText}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error("Groq response contained no structured output.");
    return parseDecisionCandidate(content);
  }
}

export class OpenAIResponsesProvider implements ModelProvider {
  readonly id = "openai-responses";

  constructor(
    readonly model = process.env.OPENAI_MODEL ?? "gpt-5-mini",
    private readonly apiKey = process.env.OPENAI_API_KEY,
  ) {
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI provider.");
  }

  async decide(context: DecisionContext): Promise<ModelAction> {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: buildPrompt(context),
        store: false,
        text: {
          format: {
            type: "json_schema",
            name: "computer_use_action",
            strict: true,
            schema: modelSchema,
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`OpenAI Responses failed (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const text = body.output_text ?? body.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text;
    if (!text) throw new Error("OpenAI response contained no structured output.");
    return assertDecision(JSON.parse(text));
  }
}

export class CodexCliProvider implements ModelProvider {
  readonly id = "codex-cli";

  constructor(
    readonly model = process.env.CODEX_MODEL ?? "codex-cli-configured-default",
    private readonly binary = process.env.CODEX_BIN ?? "codex",
  ) {}

  async decide(context: DecisionContext): Promise<ModelAction> {
    const args = [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      new URL("../../schema/model-action.schema.json", import.meta.url).pathname,
    ];
    if (this.model !== "codex-cli-configured-default") args.push("--model", this.model);
    args.push("-");

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(this.binary, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`Codex CLI failed with exit ${code}: ${stderr.slice(-2_000)}`));
      });
      child.stdin.end(buildPrompt(context));
    });
    return assertDecision(JSON.parse(output));
  }
}

export class ScriptedProvider implements ModelProvider {
  readonly id = "scripted-offline";
  readonly model = "fixture-v1";
  #index = 0;

  constructor(private readonly actions: readonly ModelAction[]) {}

  async decide(): Promise<ModelAction> {
    const action = this.actions[this.#index++];
    if (!action) throw new Error("Scripted provider ran out of actions before discovery completed.");
    return structuredClone(action);
  }
}

export function lookupBalanceScript(): ModelAction[] {
  return [
    {
      kind: "type",
      description: "Enter the member identifier",
      target: { frame: { name: "main" }, locator: { strategy: "role", role: "textbox", name: "Member ID" } },
      value: { kind: "parameter", name: "memberId" },
      risk: "safe",
      rationale: "The lookup form exposes a uniquely named member ID textbox.",
    },
    {
      kind: "click",
      description: "Submit the member lookup",
      target: { frame: { name: "main" }, locator: { strategy: "role", role: "button", name: "Search" } },
      risk: "safe",
      rationale: "Search is a reversible read-only operation.",
    },
    {
      kind: "extract",
      description: "Read the savings balance",
      target: { frame: { name: "main" }, locator: { strategy: "role", role: "status", name: "Savings balance" } },
      output: "savingsBalance",
      parseAs: "money",
      risk: "safe",
      rationale: "The balance has an accessible name and is declared by the output contract.",
    },
    {
      kind: "finish",
      summary: "Member details reached and savings balance extracted.",
      rationale: "The declared output is present and the member details checkpoint is visible.",
    },
  ];
}
