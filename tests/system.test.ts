import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import test, { after, before } from "node:test";
import type { CapabilityArtifact, DiscoverySpec, JsonValue, RunResult } from "../src/domain/types.js";
import { assertCapability, assertOutputs } from "../src/domain/validation.js";
import { DiscoveryAgent } from "../src/agent/discovery.js";
import { lookupBalanceScript, ScriptedProvider } from "../src/agent/model.js";
import { startDemoServer, type DemoServer } from "../src/demo/server.js";
import { EvidenceRecorder } from "../src/infra/evidence.js";
import { HandoffCoordinator } from "../src/handoff/coordinator.js";
import { PolicyGuard, PolicyViolation } from "../src/policy/guard.js";
import { DeterministicReplayer } from "../src/replay/replayer.js";
import { parseExtracted, TargetResolutionError, WebSurface } from "../src/surface/web-surface.js";

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

test("an uncertain click is not retried after its postcondition fails", async () => {
  const testArtifact = structuredClone(artifact);
  testArtifact.contract.outputs = {};
  testArtifact.steps = [{
    id: "single-click",
    description: "Submit once",
    action: {
      kind: "click",
      risk: "safe",
      target: { primary: { strategy: "role", role: "button", name: "Submit once" } },
    },
    timeoutMs: 1_000,
    retry: { maxAttempts: 3, backoffMs: 1 },
    postcondition: testArtifact.checkpoint,
  }];
  let clicks = 0;
  const surface = {
    enforcePolicy: async () => {},
    gotoEntrypoint: async () => {},
    policyUrlFor: async () => testArtifact.target.entrypoint,
    execute: async () => { clicks += 1; },
    conditionMet: async () => false,
    takeBlockedRequest: () => undefined,
    screenshot: async (path: string) => { await writeFile(path, "test screenshot"); },
  } as unknown as WebSurface;
  const evidence = await EvidenceRecorder.create(evidenceRoot, "replay", new Set());
  const result = await new DeterministicReplayer(new HandoffCoordinator()).run({
    artifact: testArtifact,
    inputs: { memberId: "12345" },
    surface,
    evidence,
  });
  assert.equal(result.status, "failure");
  assert.equal(clicks, 1);
});

test("approval must be explicit before a risky action executes", async () => {
  const testArtifact = structuredClone(artifact);
  testArtifact.contract.outputs = {};
  testArtifact.exceptionRules = [];
  testArtifact.steps = [{
    id: "risky-click",
    description: "Open account",
    action: {
      kind: "click",
      risk: "irreversible",
      target: { primary: { strategy: "role", role: "button", name: "Open account" } },
    },
    timeoutMs: 1_000,
    retry: { maxAttempts: 2, backoffMs: 1 },
  }];
  let clicks = 0;
  const surface = {
    page: {},
    enforcePolicy: async () => {},
    gotoEntrypoint: async () => {},
    policyUrlFor: async () => testArtifact.target.entrypoint,
    execute: async () => { clicks += 1; },
    conditionMet: async () => true,
    installOperatorRecorder: async () => {},
    collectOperatorActions: async () => [],
    stopOperatorRecorder: () => {},
    takeBlockedRequest: () => undefined,
    screenshot: async (path: string) => { await writeFile(path, "test screenshot"); },
  } as unknown as WebSurface;
  const deniedEvidence = await EvidenceRecorder.create(evidenceRoot, "replay", new Set());
  const denied = await new DeterministicReplayer(new HandoffCoordinator(async () => undefined)).run({
    artifact: testArtifact, inputs: { memberId: "12345" }, surface, evidence: deniedEvidence,
  });
  assert.equal(denied.status, "failure");
  if (denied.status === "failure") assert.equal(denied.error.code, "HUMAN_APPROVAL_REJECTED");
  assert.equal(clicks, 0);
  const approvedEvidence = await EvidenceRecorder.create(evidenceRoot, "replay", new Set());
  const approved = await new DeterministicReplayer(new HandoffCoordinator(async (_, request) => {
    assert.equal(request.kind, "approval");
    assert.equal(request.approval?.actionKind, "click");
    assert.match(request.approval?.actionDigest ?? "", /^[a-f0-9]{64}$/);
    return "approved";
  })).run({ artifact: testArtifact, inputs: { memberId: "12345" }, surface, evidence: approvedEvidence });
  assert.equal(approved.status, "success");
  assert.equal(clicks, 1);
});

test("browser requests are blocked before leaving allowed routes", async () => {
  const surface = await WebSurface.launch(spec.target);
  try {
    await surface.enforcePolicy(new PolicyGuard(spec.target, spec.policy));
    await surface.gotoEntrypoint();
    const main = surface.page.frames().find((frame) => frame.name() === "main");
    assert.ok(main);
    await main.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/outside-allowlist";
      link.textContent = "Unsafe navigation";
      document.body.append(link);
    });
    await assert.rejects(
      () => surface.execute({
        kind: "click", risk: "safe",
        target: { frame: { name: "main" }, primary: { strategy: "role", role: "link", name: "Unsafe navigation" } },
      }, {}),
      (error: unknown) => error instanceof PolicyViolation && error.code === "ROUTE_NOT_ALLOWED",
    );
  } finally {
    await surface.close();
  }
});

test("not-visible checks reject ambiguous targets and missing frames", async () => {
  const surface = await WebSurface.launch(spec.target);
  try {
    await surface.gotoEntrypoint();
    const main = surface.page.frames().find((frame) => frame.name() === "main");
    assert.ok(main);
    await main.evaluate(() => {
      for (let index = 0; index < 2; index += 1) {
        const item = document.createElement("span");
        item.className = "duplicated";
        document.body.append(item);
      }
    });
    await assert.rejects(
      () => surface.conditionMet({ kind: "not_visible", target: { frame: { name: "main" }, primary: { strategy: "css", selector: ".duplicated" } } }),
      TargetResolutionError,
    );
    await assert.rejects(
      () => surface.conditionMet({ kind: "not_visible", target: { frame: { name: "missing" }, primary: { strategy: "css", selector: ".missing" } } }),
      TargetResolutionError,
    );
  } finally {
    await surface.close();
  }
});

test("operator action recording survives a frame navigation", async () => {
  const surface = await WebSurface.launch(spec.target);
  try {
    await surface.gotoEntrypoint();
    await surface.installOperatorRecorder();
    const navigation = surface.page.frames().find((frame) => frame.name() === "navigation");
    assert.ok(navigation);
    await navigation.getByRole("link", { name: "Maintenance" }).click();
    const main = surface.page.frames().find((frame) => frame.name() === "main");
    assert.ok(main);
    await main.waitForURL("**/maintenance");
    await main.evaluate(() => {
      const button = document.createElement("button");
      button.textContent = "Operator action after navigation";
      document.body.append(button);
    });
    await main.getByRole("button", { name: "Operator action after navigation" }).click();
    const actions = await surface.collectOperatorActions();
    assert.ok(actions.some((action) => action.kind === "navigate" && action.element.endsWith(":/maintenance")));
    assert.ok(actions.some((action) => action.kind === "click" && action.element.includes("Operator action after navigation")));
  } finally {
    await surface.close();
  }
});

test("extracted values must match strict parsers and the declared output contract", () => {
  assert.deepEqual(parseExtracted("$4,281.73", "money"), { currency: "USD", amountMinor: 428173 });
  assert.throws(() => parseExtracted("$", "money"));
  assert.throws(() => parseExtracted("", "number"));
  assert.throws(() => parseExtracted("12abc", "integer"));
  assert.throws(() => parseExtracted("maybe", "boolean"));
  assert.throws(() => assertOutputs(spec.contract.outputs, { savingsBalance: { currency: "USD", amountMinor: 1.5 } }));
});
