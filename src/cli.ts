#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { CapabilityArtifact, DiscoverySpec, JsonValue } from "./domain/types.js";
import { assertCapability } from "./domain/validation.js";
import { DiscoveryAgent } from "./agent/discovery.js";
import {
  CodexCliProvider,
  lookupBalanceScript,
  OpenAIResponsesProvider,
  ScriptedProvider,
  type ModelProvider,
} from "./agent/model.js";
import { startDemoServer, type DemoServer } from "./demo/server.js";
import { EvidenceRecorder } from "./infra/evidence.js";
import { HandoffCoordinator } from "./handoff/coordinator.js";
import { DeterministicReplayer } from "./replay/replayer.js";
import { WebSurface } from "./surface/web-surface.js";

function flags(argv: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) continue;
    const [name, inline] = item.slice(2).split("=", 2);
    if (inline !== undefined) result.set(name!, inline);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) result.set(name!, argv[++index]!);
    else result.set(name!, true);
  }
  return result;
}

function option(options: Map<string, string | true>, name: string, fallback?: string): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : fallback;
}

function jsonInputs(raw = "{}"): Record<string, JsonValue> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--inputs must be a JSON object.");
  return value as Record<string, JsonValue>;
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as T;
}

function sensitiveValues(inputs: Record<string, JsonValue>): Set<string> {
  return new Set(Object.values(inputs).filter((value): value is string => typeof value === "string"));
}

async function maybeDemo(options: Map<string, string | true>): Promise<DemoServer | undefined> {
  return options.has("with-demo") ? startDemoServer(4318) : undefined;
}

function provider(name: string): ModelProvider {
  switch (name) {
    case "openai":
      return new OpenAIResponsesProvider();
    case "codex":
      return new CodexCliProvider();
    case "scripted":
      return new ScriptedProvider(lookupBalanceScript());
    default:
      throw new Error(`Unknown provider ${name}; expected openai, codex, or scripted.`);
  }
}

async function discover(options: Map<string, string | true>): Promise<void> {
  const specPath = option(options, "spec", "examples/lookup-member-balance.spec.json")!;
  const artifactPath = resolve(option(options, "artifact", "artifacts/lookup-member-balance.v1.json")!);
  const inputs = jsonInputs(option(options, "inputs", '{"memberId":"12345"}'));
  const spec = await loadJson<DiscoverySpec>(specPath);
  const demo = await maybeDemo(options);
  const evidence = await EvidenceRecorder.create(
    resolve(option(options, "evidence", "runs")!),
    "discovery",
    sensitiveValues(inputs),
  );
  const surface = await WebSurface.launch(spec.target, { headless: !options.has("headed") });

  try {
    const result = await new DiscoveryAgent(
      provider(option(options, "provider", "scripted")!),
      new HandoffCoordinator(),
    ).run({ spec, inputs, surface, evidence });
    assertCapability(result.artifact);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(result.artifact, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ status: "success", artifact: artifactPath, evidence: result.evidenceDir }, null, 2));
  } finally {
    await surface.close();
    await demo?.close();
  }
}

async function replay(options: Map<string, string | true>): Promise<void> {
  const artifactPath = option(options, "artifact", "artifacts/lookup-member-balance.v1.json")!;
  const artifact = await loadJson<CapabilityArtifact>(artifactPath);
  assertCapability(artifact);
  const inputs = jsonInputs(option(options, "inputs", '{"memberId":"12345"}'));
  const demo = await maybeDemo(options);
  const evidence = await EvidenceRecorder.create(resolve(option(options, "evidence", "runs")!), "replay", sensitiveValues(inputs));
  const surface = await WebSurface.launch(artifact.target, { headless: !options.has("headed") });
  const tenant = option(options, "tenant");

  try {
    const result = await new DeterministicReplayer(new HandoffCoordinator()).run({
      artifact,
      inputs,
      surface,
      evidence,
      ...(tenant ? { tenant } : {}),
      handoffOnUnexpectedFailure: options.has("handoff-on-failure"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failure") process.exitCode = 2;
  } finally {
    await surface.close();
    await demo?.close();
  }
}

async function demo(options: Map<string, string | true>): Promise<void> {
  const port = Number(option(options, "port", "4318"));
  const server = await startDemoServer(port);
  console.log(`Meridian Core demo running at ${server.baseUrl}. Press Ctrl+C to stop.`);
  await new Promise<void>((resolvePromise) => {
    process.once("SIGINT", resolvePromise);
    process.once("SIGTERM", resolvePromise);
  });
  await server.close();
}

function usage(): string {
  return `Usage:
  npm run demo
  npm run discover -- --with-demo --provider openai --inputs '{"memberId":"12345"}'
  npm run replay -- --with-demo --artifact artifacts/lookup-member-balance.v1.json --inputs '{"memberId":"12345"}'

Providers: openai (genuine API), codex (genuine Codex CLI), scripted (offline fixture).`;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "discover") await discover(flags(rest));
  else if (command === "replay") await replay(flags(rest));
  else if (command === "demo") await demo(flags(rest));
  else console.log(usage());
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}
