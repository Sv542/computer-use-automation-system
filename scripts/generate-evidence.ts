import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CapabilityArtifact, DiscoverySpec, JsonValue, RunResult } from "../src/domain/types.js";
import { assertCapability } from "../src/domain/validation.js";
import { DiscoveryAgent } from "../src/agent/discovery.js";
import {
  CodexCliProvider,
  GroqChatCompletionsProvider,
  lookupBalanceScript,
  OpenAIResponsesProvider,
  ScriptedProvider,
  type ModelProvider,
} from "../src/agent/model.js";
import { startDemoServer } from "../src/demo/server.js";
import { EvidenceRecorder } from "../src/infra/evidence.js";
import { redactForEvidence } from "../src/infra/redaction.js";
import { HandoffCoordinator, type Operator } from "../src/handoff/coordinator.js";
import { DeterministicReplayer } from "../src/replay/replayer.js";
import { WebSurface } from "../src/surface/web-surface.js";

const root = resolve("evidence");
const runsRoot = resolve(root, "runs");
const spec = JSON.parse(await readFile(resolve("examples/lookup-member-balance.spec.json"), "utf8")) as DiscoverySpec;

function discoveryProvider(): ModelProvider {
  switch (process.env.EVIDENCE_DISCOVERY_PROVIDER ?? "scripted") {
    case "groq":
      return new GroqChatCompletionsProvider();
    case "codex":
      return new CodexCliProvider();
    case "openai":
      return new OpenAIResponsesProvider();
    case "scripted":
      return new ScriptedProvider(lookupBalanceScript());
    default:
      throw new Error("EVIDENCE_DISCOVERY_PROVIDER must be groq, codex, openai, or scripted.");
  }
}

async function saveResult(directory: string, result: RunResult, values: ReadonlySet<string>): Promise<void> {
  await writeFile(resolve(directory, "result.json"), `${JSON.stringify(redactForEvidence(result, values), null, 2)}\n`, "utf8");
}

async function replayCase(
  artifact: CapabilityArtifact,
  label: string,
  memberId: string,
  expectedStatus: RunResult["status"],
  operator?: Operator,
): Promise<void> {
  const values = new Set([memberId]);
  const evidence = await EvidenceRecorder.create(runsRoot, "replay", values, label);
  const surface = await WebSurface.launch(artifact.target);
  try {
    const result = await new DeterministicReplayer(new HandoffCoordinator(operator)).run({
      artifact,
      inputs: { memberId },
      surface,
      evidence,
    });
    if (result.status !== expectedStatus) {
      throw new Error(`${label}: expected ${expectedStatus}, received ${JSON.stringify(result)}`);
    }
    await saveResult(evidence.directory, result, values);
  } finally {
    await surface.close();
  }
}

await mkdir(resolve(root, "artifacts"), { recursive: true });
const server = await startDemoServer(4318);
try {
  let artifact: CapabilityArtifact;
  if (process.env.EVIDENCE_REUSE_ARTIFACT === "1") {
    artifact = JSON.parse(
      await readFile(resolve(root, "artifacts", "lookup-member-balance.v1.json"), "utf8"),
    ) as CapabilityArtifact;
  } else {
    const inputs: Record<string, JsonValue> = { memberId: "12345" };
    const discoveryEvidence = await EvidenceRecorder.create(runsRoot, "discovery", new Set(["12345"]), "discovery-live");
    const discoverySurface = await WebSurface.launch(spec.target);
    try {
      const discovery = await new DiscoveryAgent(discoveryProvider(), new HandoffCoordinator()).run({
        spec,
        inputs,
        surface: discoverySurface,
        evidence: discoveryEvidence,
      });
      artifact = discovery.artifact;
    } finally {
      await discoverySurface.close();
    }
  }
  assertCapability(artifact);
  await writeFile(
    resolve(root, "artifacts", "lookup-member-balance.v1.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8",
  );

  await replayCase(artifact, "replay-success", "12345", "success");
  await replayCase(artifact, "replay-not-found", "99999", "business_outcome");
  await replayCase(artifact, "replay-recovered-session", "55555", "success");
  await replayCase(artifact, "replay-permission-denied", "88888", "failure");
  await replayCase(
    artifact,
    "replay-human-handoff",
    "77777",
    "success",
    async (page) => {
      const main = page.frames().find((frame) => frame.name() === "main");
      if (!main) throw new Error("Operator could not find the live main frame.");
      await main.getByRole("button", { name: "Operator: verification complete" }).click();
    },
  );
} finally {
  await server.close();
}

console.log(`Evidence generated under ${root}`);
