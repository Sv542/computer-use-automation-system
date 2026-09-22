import type {
  BrowserAction,
  CapabilityArtifact,
  CapabilityStep,
  ExceptionRule,
  JsonValue,
  RunFailure,
  RunResult,
} from "../domain/types.js";
import { assertCapability, assertInputs, assertOutputs } from "../domain/validation.js";
import { EvidenceRecorder } from "../infra/evidence.js";
import { HandoffCoordinator } from "../handoff/coordinator.js";
import { PolicyGuard, PolicyViolation } from "../policy/guard.js";
import { TargetResolutionError, WebSurface } from "../surface/web-surface.js";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function specializeForTenant(artifact: CapabilityArtifact, tenant?: string): CapabilityArtifact {
  if (!tenant) return structuredClone(artifact);
  const override = artifact.compatibility.tenantOverrides?.[tenant];
  if (!override) return structuredClone(artifact);
  const specialized = structuredClone(artifact);
  if (override.entrypoint) specialized.target.entrypoint = override.entrypoint;
  for (const step of specialized.steps) {
    const target = override.locatorOverrides?.[step.id];
    if (target && "target" in step.action) step.action.target = target;
  }
  return specialized;
}

export class DeterministicReplayer {
  constructor(private readonly handoff: HandoffCoordinator) {}

  private failure(
    artifact: CapabilityArtifact,
    evidence: EvidenceRecorder,
    error: RunFailure,
  ): RunResult {
    return {
      status: "failure",
      runId: evidence.runId,
      capabilityId: artifact.capability.id,
      error,
      evidenceDir: evidence.directory,
    };
  }

  private async captureFailure(surface: WebSurface, evidence: EvidenceRecorder, label: string): Promise<string> {
    const path = evidence.screenshotPath(label);
    await surface.screenshot(path);
    return evidence.relativePath(path);
  }

  private async matchedRule(surface: WebSurface, rules: ExceptionRule[]): Promise<ExceptionRule | undefined> {
    for (const rule of rules) {
      if (await surface.conditionMet(rule.when)) return rule;
    }
    return undefined;
  }

  private async handleException(options: {
    artifact: CapabilityArtifact;
    step: CapabilityStep;
    inputs: Record<string, JsonValue>;
    surface: WebSurface;
    evidence: EvidenceRecorder;
    policy: PolicyGuard;
    recoveryCounts: Map<string, number>;
  }): Promise<RunResult | "continue" | undefined> {
    const rule = await this.matchedRule(options.surface, options.artifact.exceptionRules);
    if (!rule) return;
    await options.evidence.event("exception_detected", {
      stepId: options.step.id,
      ruleId: rule.id,
      classification: rule.classification,
      code: rule.code,
      message: rule.message,
    });

    if (rule.classification === "business_outcome") {
      return {
        status: "business_outcome",
        runId: options.evidence.runId,
        capabilityId: options.artifact.capability.id,
        outcome: { code: rule.code, message: rule.message },
        evidenceDir: options.evidence.directory,
      };
    }

    if (rule.classification === "hard_failure") {
      const evidenceRef = await this.captureFailure(options.surface, options.evidence, rule.code);
      return this.failure(options.artifact, options.evidence, {
        code: rule.code,
        classification: "application",
        message: rule.message,
        stepId: options.step.id,
        observed: `Matched exception rule ${rule.id}`,
        retryable: false,
        evidenceRef,
      });
    }

    if (rule.classification === "human_required") {
      const disposition = await this.handoff.request({
        reason: rule.message,
        capabilityId: options.artifact.capability.id,
        stepId: options.step.id,
        surface: options.surface,
        evidence: options.evidence,
      });
      if (disposition === "rejected") {
        return this.failure(options.artifact, options.evidence, {
          code: "HANDOFF_REJECTED",
          classification: "application",
          message: "The operator declined to complete the manual intervention.",
          stepId: options.step.id,
          retryable: false,
        });
      }
      if (await options.surface.conditionMet(rule.when)) {
        const evidenceRef = await this.captureFailure(options.surface, options.evidence, "handoff-unresolved");
        return this.failure(options.artifact, options.evidence, {
          code: "HANDOFF_UNRESOLVED",
          classification: "application",
          message: "The blocking condition remained after control returned from the operator.",
          stepId: options.step.id,
          retryable: false,
          evidenceRef,
        });
      }
      return "continue";
    }

    const attempts = (options.recoveryCounts.get(rule.id) ?? 0) + 1;
    options.recoveryCounts.set(rule.id, attempts);
    if (attempts > (rule.maxRecoveries ?? 1)) {
      const evidenceRef = await this.captureFailure(options.surface, options.evidence, "recovery-exhausted");
      return this.failure(options.artifact, options.evidence, {
        code: "RECOVERY_EXHAUSTED",
        classification: "application",
        message: `Recovery ${rule.id} exceeded its bounded attempt limit.`,
        stepId: options.step.id,
        retryable: false,
        evidenceRef,
      });
    }
    for (const action of rule.recovery ?? []) {
      options.policy.authorize(action, await options.surface.policyUrlFor(action));
      await options.surface.execute(action, options.inputs);
      await options.evidence.event("recovery_action_completed", { ruleId: rule.id, attempt: attempts, action });
    }
    return "continue";
  }

  async run(options: {
    artifact: CapabilityArtifact;
    inputs: Record<string, JsonValue>;
    surface: WebSurface;
    evidence: EvidenceRecorder;
    tenant?: string;
    handoffOnUnexpectedFailure?: boolean;
  }): Promise<RunResult> {
    const artifact = specializeForTenant(options.artifact, options.tenant);
    assertCapability(artifact);
    assertInputs(artifact.contract.inputs, options.inputs);
    const policy = new PolicyGuard(artifact.target, artifact.policy);
    const outputs: Record<string, JsonValue> = {};
    const recoveryCounts = new Map<string, number>();

    try {
      policy.assertUrl(artifact.target.entrypoint);
      await options.surface.enforcePolicy(policy);
      await options.evidence.event("run_started", {
        mode: "deterministic_replay",
        capabilityId: artifact.capability.id,
        capabilityVersion: artifact.capability.version,
        tenant: options.tenant ?? "base",
        modelCallsAllowed: false,
      });
      await options.surface.gotoEntrypoint();

      for (const step of artifact.steps) {
        await options.evidence.event("step_started", {
          stepId: step.id,
          description: step.description,
          action: step.action,
        });
        let completed = false;
        let lastError: unknown;
        const allowedAttempts = step.retry.maxAttempts + (options.handoffOnUnexpectedFailure && step.action.kind === "extract" ? 1 : 0);

        for (let attempt = 1; attempt <= allowedAttempts && !completed; attempt += 1) {
          let executionStarted = false;
          let executionReturned = false;
          try {
            const policyUrl = await options.surface.policyUrlFor(step.action);
            try {
              policy.authorize(step.action, policyUrl);
            } catch (error) {
              if (!(error instanceof PolicyViolation) || error.code !== "HUMAN_APPROVAL_REQUIRED") throw error;
              const disposition = await this.handoff.request({
                reason: `Approve ${step.description}: ${error.message}`,
                capabilityId: artifact.capability.id,
                stepId: step.id,
                approvalAction: step.action,
                surface: options.surface,
                evidence: options.evidence,
              });
              if (disposition !== "approved") {
                throw new PolicyViolation("HUMAN_APPROVAL_REJECTED", "The operator did not approve this exact action.");
              }
              policy.authorize(step.action, await options.surface.policyUrlFor(step.action), true);
            }
            executionStarted = true;
            const value = await options.surface.execute(step.action, options.inputs, step.timeoutMs);
            executionReturned = true;
            if (step.action.kind === "extract") outputs[step.action.output] = value ?? null;
            if (step.postcondition && !(await options.surface.conditionMet(step.postcondition))) {
              throw new Error(`Postcondition failed for ${step.id}.`);
            }
            completed = true;
            await options.evidence.event("step_completed", { stepId: step.id, attempt, output: step.action.kind === "extract" ? step.action.output : undefined });
          } catch (error) {
            lastError = options.surface.takeBlockedRequest() ?? error;
            await options.evidence.event("step_attempt_failed", {
              stepId: step.id,
              attempt,
              message: lastError instanceof Error ? lastError.message : String(lastError),
              locatorAttempts: lastError instanceof TargetResolutionError ? lastError.attempts : undefined,
            });
            // Once a click, type, or navigation may have run, retrying could
            // repeat a side effect. A target-resolution failure is pre-action.
            const safeToRetry = step.action.kind === "extract" ||
              (!executionReturned && (!executionStarted || lastError instanceof TargetResolutionError));
            if (lastError instanceof PolicyViolation || !safeToRetry) break;
            if (attempt < step.retry.maxAttempts) await pause(step.retry.backoffMs * attempt);
            else if (attempt === step.retry.maxAttempts && options.handoffOnUnexpectedFailure) {
              const disposition = await this.handoff.request({
                reason: `Replay could not complete ${step.id}: ${error instanceof Error ? error.message : String(error)}`,
                capabilityId: artifact.capability.id,
                stepId: step.id,
                surface: options.surface,
                evidence: options.evidence,
              });
              if (disposition === "rejected") break;
            }
          }
        }

        if (!completed) {
          const evidenceRef = await this.captureFailure(options.surface, options.evidence, "step-failed");
          const observed = lastError instanceof TargetResolutionError ? lastError.attempts.join("; ") : undefined;
          const error = this.failure(artifact, options.evidence, {
            code: lastError instanceof PolicyViolation ? lastError.code : lastError instanceof TargetResolutionError ? "TARGET_NOT_FOUND" : "STEP_FAILED",
            classification: lastError instanceof PolicyViolation ? "policy" : lastError instanceof TargetResolutionError ? "target" : "application",
            message: lastError instanceof Error ? lastError.message : "Step failed without an error message.",
            stepId: step.id,
            expected: step.description,
            ...(observed ? { observed } : {}),
            retryable: false,
            evidenceRef,
          });
          await options.evidence.event("run_completed", error);
          return error;
        }

        const exceptionResult = await this.handleException({
          artifact,
          step,
          inputs: options.inputs,
          surface: options.surface,
          evidence: options.evidence,
          policy,
          recoveryCounts,
        });
        if (exceptionResult && exceptionResult !== "continue") {
          await options.evidence.event("run_completed", exceptionResult);
          return exceptionResult;
        }
      }

      if (!(await options.surface.conditionMet(artifact.checkpoint))) {
        const evidenceRef = await this.captureFailure(options.surface, options.evidence, "checkpoint-failed");
        const result = this.failure(artifact, options.evidence, {
          code: "CHECKPOINT_FAILED",
          classification: "checkpoint",
          message: "Replay finished its actions but did not reach the declared success condition.",
          expected: JSON.stringify(artifact.checkpoint),
          observed: JSON.stringify(await options.surface.observe()),
          retryable: false,
          evidenceRef,
        });
        await options.evidence.event("run_completed", result);
        return result;
      }
      const missing = Object.keys(artifact.contract.outputs).filter((name) => !(name in outputs));
      if (missing.length > 0) {
        const result = this.failure(artifact, options.evidence, {
          code: "OUTPUT_MISSING",
          classification: "checkpoint",
          message: `Replay did not produce declared outputs: ${missing.join(", ")}`,
          retryable: false,
        });
        await options.evidence.event("run_completed", result);
        return result;
      }
      try {
        assertOutputs(artifact.contract.outputs, outputs);
      } catch (error) {
        const result = this.failure(artifact, options.evidence, {
          code: "OUTPUT_INVALID",
          classification: "checkpoint",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
        await options.evidence.event("run_completed", result);
        return result;
      }

      const screenshot = options.evidence.screenshotPath("replay-success");
      await options.surface.screenshot(screenshot);
      const result: RunResult = {
        status: "success",
        runId: options.evidence.runId,
        capabilityId: artifact.capability.id,
        outputs,
        evidenceDir: options.evidence.directory,
      };
      await options.evidence.event("run_completed", {
        ...result,
        screenshot: options.evidence.relativePath(screenshot),
      });
      return result;
    } catch (error) {
      const evidenceRef = await this.captureFailure(options.surface, options.evidence, "unhandled-failure").catch(() => undefined);
      const result = this.failure(artifact, options.evidence, {
        code: error instanceof PolicyViolation ? error.code : "UNHANDLED_FAILURE",
        classification: error instanceof PolicyViolation ? "policy" : "application",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        ...(evidenceRef ? { evidenceRef } : {}),
      });
      await options.evidence.event("run_completed", result);
      return result;
    }
  }
}
