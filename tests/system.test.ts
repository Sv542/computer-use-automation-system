import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test, { after, before } from "node:test";
import type { CapabilityArtifact, DiscoverySpec, JsonValue, RunResult } from "../src/domain/types.js";
import { assertCapability } from "../src/domain/validation.js";
import { DiscoveryAgent } from "../src/agent/discovery.js";
import { lookupBalanceScript, ScriptedProvider } from "../src/agent/model.js";
import { startDemoServer, type DemoServer } from "../src/demo/server.js";
import { EvidenceRecorder } from "../src/infra/evidence.js";
import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import { PolicyGuard, PolicyViolation } from "../src/policy/guard.js";
import { DeterministicReplayer } from "../src/replay/replayer.js";
import { WebSurface } from "../src/surface/web-surface.js";

let server: DemoServer;
let spec: DiscoverySpec;
let artifact: CapabilityArtifact;
let evidenceRoot: string;

before(async () => {
  server = await startDemoServer(4318);
  evidenceRoot = await mkdtemp(join(tmpdir(), "capability-runner-test-"));
  spec = JSON.parse(await readFile("examples/lookup-member-balance.spec.json", "utf8")) as DiscoverySpec;
  const inputs: Record<string, JsonValue> = { memberId: "12345" };
  const evidence = await EvidenceRecorder.create(evidenceRoot, "discovery", new Set(["12345"]));
  const surface = await WebSurface.launch(spec.target);
  try {
    artifact = (
      await new DiscoveryAgent(
        new ScriptedProvider(lookupBalanceScript()),
        new HandoffCoordinator(),
      ).run({ spec, inputs, surface, evidence })
    ).artifact;
  } finally {
    await surface.close();
  }
});

after(async () => {
  await server.close();
});

async function replay(memberId: string, handoff = new HandoffCoordinator()): Promise<RunResult> {
  const evidence = await EvidenceRecorder.create(evidenceRoot, "replay", new Set([memberId]));
  const surface = await WebSurface.launch(artifact.target);
  try {
    return await new DeterministicReplayer(handoff).run({
      artifact,
      inputs: { memberId },
      surface,
      evidence,
    });
  } finally {
    await surface.close();
  }
}

test("discovery emits a schema-valid, parameterized artifact", () => {
  assert.doesNotThrow(() => assertCapability(artifact));
  assert.equal(artifact.provenance.provider, "scripted-offline");
  assert.equal(artifact.steps[0]?.action.kind, "type");
  const action = artifact.steps[0]?.action;
  assert.ok(action?.kind === "type");
  assert.deepEqual(action.value, { kind: "parameter", name: "memberId" });
  assert.equal(JSON.stringify(artifact).includes("12345"), false);
});

test("deterministic replay returns the typed output without a model", async () => {
  const result = await replay("12345");
  assert.equal(result.status, "success");
  if (result.status === "success") {
    assert.deepEqual(result.outputs.savingsBalance, { currency: "USD", amountMinor: 428173 });
    const persisted = await readFile(join(result.evidenceDir, "events.jsonl"), "utf8");
    assert.equal(persisted.includes("12345"), false);
    assert.equal(persisted.includes("428173"), false);
    assert.match(persisted, /\[REDACTED:outputs\]/);
  }
});

test("schema validation rejects malformed capabilities", () => {
  const malformed = structuredClone(artifact) as Partial<CapabilityArtifact>;
  delete malformed.schemaVersion;
  assert.throws(() => assertCapability(malformed), /Capability artifact is invalid/);
});

test("not found is a business outcome, not a crash", async () => {
  const result = await replay("99999");
  assert.equal(result.status, "business_outcome");
  if (result.status === "business_outcome") assert.equal(result.outcome.code, "MEMBER_NOT_FOUND");
});

test("a known session timeout is recovered once", async () => {
  const result = await replay("55555");
  assert.equal(result.status, "success");
});

test("permission denial is a hard, debuggable failure", async () => {
  const result = await replay("88888");
  assert.equal(result.status, "failure");
  if (result.status === "failure") {
    assert.equal(result.error.code, "PERMISSION_DENIED");
    assert.ok(result.error.evidenceRef?.endsWith(".png"));
  }
});

test("human handoff uses the same live page and then resumes", async () => {
  let operatedOnExpectedPage = false;
  const handoff = new HandoffCoordinator(async (page) => {
    const main = page.frames().find((frame) => frame.name() === "main");
    assert.ok(main);
    operatedOnExpectedPage = main.url().includes("id=77777");
    await main.getByRole("button", { name: "Operator: verification complete" }).click();
  });
  const result = await replay("77777", handoff);
  assert.equal(operatedOnExpectedPage, true);
  assert.equal(result.status, "success");
});

test("policy blocks non-allowlisted origins and risky clicks", () => {
  const guard = new PolicyGuard(spec.target, spec.policy);
  assert.throws(() => guard.assertUrl("https://example.com/members"), PolicyViolation);
  assert.throws(
    () => guard.authorize(
      {
        kind: "click",
        risk: "irreversible",
        target: { primary: { strategy: "role", role: "button", name: "Delete member" } },
      },
      spec.target.entrypoint,
    ),
    (error: unknown) => error instanceof PolicyViolation && error.code === "HUMAN_APPROVAL_REQUIRED",
  );
});
