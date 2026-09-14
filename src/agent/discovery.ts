import type {
  BrowserAction,
  CapabilityArtifact,
  CapabilityStep,
  DiscoverySpec,
  JsonValue,
  ModelAction,
} from "../domain/types.js";
import { assertInputs } from "../domain/validation.js";
import { EvidenceRecorder } from "../infra/evidence.js";
import { HandoffCoordinator } from "../handoff/coordinator.js";
import { PolicyGuard, PolicyViolation } from "../policy/guard.js";
import { WebSurface } from "../surface/web-surface.js";
import type { ModelProvider } from "./model.js";

function renderGoal(template: string, inputs: Record<string, JsonValue>): string {
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, name: string) => String(inputs[name] ?? `{{${name}}}`));
}

function decisionSummary(decision: ModelAction): { kind: string; description: string } {
  if (decision.kind === "finish") return { kind: decision.kind, description: decision.summary };
  if (decision.kind === "escalate") return { kind: decision.kind, description: decision.reason };
  return { kind: decision.kind, description: decision.description };
}

async function toBrowserAction(decision: Exclude<ModelAction, { kind: "finish" | "escalate" }>, surface: WebSurface): Promise<BrowserAction> {
  const target = await surface.enrichTarget({
    ...(decision.target.frame ? { frame: decision.target.frame } : {}),
    primary: decision.target.locator,
  });
  switch (decision.kind) {
    case "click":
      return { kind: "click", target, risk: decision.risk };
    case "type":
      return { kind: "type", target, value: decision.value, clear: true, risk: decision.risk };
    case "extract":
      return { kind: "extract", target, output: decision.output, parseAs: decision.parseAs, risk: decision.risk };
  }
}

export interface DiscoveryResult {
  artifact: CapabilityArtifact;
  outputs: Record<string, JsonValue>;
  evidenceDir: string;
}

export class DiscoveryAgent {
  constructor(
    private readonly model: ModelProvider,
    private readonly handoff: HandoffCoordinator,
  ) {}

  async run(options: {
    spec: DiscoverySpec;
    inputs: Record<string, JsonValue>;
    surface: WebSurface;
    evidence: EvidenceRecorder;
    maxSteps?: number;
  }): Promise<DiscoveryResult> {
    const maxSteps = options.maxSteps ?? 12;
    assertInputs(options.spec.contract.inputs, options.inputs);
    const policy = new PolicyGuard(options.spec.target, options.spec.policy);
    policy.assertUrl(options.spec.target.entrypoint);

    const goal = renderGoal(options.spec.contract.goalTemplate, options.inputs);
    const recordedSteps: CapabilityStep[] = [];
    const completedActions: Array<{ kind: string; description: string }> = [];
    const outputs: Record<string, JsonValue> = {};
    await options.evidence.event("run_started", {
      mode: "discovery",
      goalTemplate: options.spec.contract.goalTemplate,
      provider: this.model.id,
      model: this.model.model,
      maxSteps,
    });
    await options.surface.gotoEntrypoint();

    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber += 1) {
      const observation = await options.surface.observe();
      await options.evidence.event("observation", {
        step: stepNumber,
        url: observation.url,
        frames: observation.frames.map((frame) => ({
          name: frame.name,
          url: frame.url,
          title: frame.title,
          text: frame.text,
          controls: frame.controls,
        })),
      });
      const decision = await this.model.decide({
        goal,
        spec: options.spec,
        inputs: options.inputs,
        observation,
        completedActions,
        extractedOutputs: Object.keys(outputs),
        step: stepNumber,
        maxSteps,
      });
      await options.evidence.event("model_decision", {
        step: stepNumber,
        kind: decision.kind,
        summary: decisionSummary(decision).description,
        action: decision,
      });

      if (decision.kind === "escalate") {
        await this.handoff.request({
          reason: decision.reason,
          capabilityId: options.spec.capability.id,
          stepId: `discovery-${stepNumber}`,
          surface: options.surface,
          evidence: options.evidence,
        });
        completedActions.push(decisionSummary(decision));
        continue;
      }

      if (decision.kind === "finish") {
        const missingOutputs = Object.keys(options.spec.contract.outputs).filter((name) => !(name in outputs));
        if (missingOutputs.length > 0) throw new Error(`Model finished before extracting: ${missingOutputs.join(", ")}`);
        if (!(await options.surface.conditionMet(options.spec.checkpoint))) {
          throw new Error("Model declared success, but the capability checkpoint was not satisfied.");
        }
        const artifact: CapabilityArtifact = {
          schemaVersion: "1.0.0",
          capability: {
            ...options.spec.capability,
            version: "1.0.0",
            approval: "draft",
          },
          target: options.spec.target,
          compatibility: options.spec.compatibility,
          contract: options.spec.contract,
          policy: options.spec.policy,
          steps: recordedSteps,
          exceptionRules: options.spec.exceptionRules,
          checkpoint: options.spec.checkpoint,
          provenance: {
            sourceRunId: options.evidence.runId,
            discoveredAt: new Date().toISOString(),
            provider: this.model.id,
            model: this.model.model,
          },
        };
        const screenshot = options.evidence.screenshotPath("discovery-success");
        await options.surface.screenshot(screenshot);
        await options.evidence.event("run_completed", {
          status: "success",
          stepCount: recordedSteps.length,
          outputs,
          checkpoint: options.spec.checkpoint,
          screenshot: options.evidence.relativePath(screenshot),
        });
        return { artifact, outputs, evidenceDir: options.evidence.directory };
      }

      const action = await toBrowserAction(decision, options.surface);
      const policyUrl = await options.surface.policyUrlFor(action);
      try {
        policy.authorize(action, policyUrl);
      } catch (error) {
        if (!(error instanceof PolicyViolation) || error.code !== "HUMAN_APPROVAL_REQUIRED") throw error;
        await this.handoff.request({
          reason: error.message,
          capabilityId: options.spec.capability.id,
          stepId: `discovery-${stepNumber}`,
          surface: options.surface,
          evidence: options.evidence,
        });
        policy.authorize(action, policyUrl, true);
      }
      const value = await options.surface.execute(action, options.inputs);
      const step: CapabilityStep = {
        id: `step-${String(recordedSteps.length + 1).padStart(2, "0")}`,
        description: decision.description,
        action,
        timeoutMs: 5_000,
        retry: { maxAttempts: 2, backoffMs: 250 },
      };
      recordedSteps.push(step);
      completedActions.push(decisionSummary(decision));
      if (action.kind === "extract") outputs[action.output] = value ?? null;
      await options.evidence.event("action_completed", {
        stepId: step.id,
        description: step.description,
        action,
        extractedOutput: action.kind === "extract" ? action.output : undefined,
      });
    }

    const screenshot = options.evidence.screenshotPath("discovery-max-steps");
    await options.surface.screenshot(screenshot);
    await options.evidence.event("run_completed", {
      status: "failure",
      code: "MAX_STEPS",
      screenshot: options.evidence.relativePath(screenshot),
    });
    throw new Error(`Discovery stopped after ${maxSteps} steps.`);
  }
}
