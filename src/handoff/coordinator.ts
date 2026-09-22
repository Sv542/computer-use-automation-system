import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Page } from "playwright";
import type { BrowserAction, InterventionRequest } from "../domain/types.js";
import { EvidenceRecorder } from "../infra/evidence.js";
import { redactForEvidence } from "../infra/redaction.js";
import { WebSurface } from "../surface/web-surface.js";

export type HandoffDisposition = "resumed" | "approved" | "rejected";
export type Operator = (page: Page, request: InterventionRequest) => Promise<HandoffDisposition | void>;

export class HandoffCoordinator {
  #controller: "automation" | "operator" = "automation";
  #epoch = 0;

  constructor(private readonly operator?: Operator) {}

  get controller(): "automation" | "operator" {
    return this.#controller;
  }

  private async waitForManualResume(request: InterventionRequest): Promise<HandoffDisposition> {
    if (!input.isTTY) {
      throw new Error("Manual handoff requires an interactive terminal or a configured operator adapter.");
    }
    const prompt = createInterface({ input, output });
    try {
      if (request.kind === "approval") {
        const answer = await prompt.question(
          `Automation paused: ${request.reason} [${request.approval?.actionKind}, ${request.approval?.actionDigest}]. Do not perform this action manually. Type APPROVE to let automation perform it, or anything else to reject: `,
        );
        return answer.trim().toUpperCase() === "APPROVE" ? "approved" : "rejected";
      }
      await prompt.question("Automation paused. Complete the step in the open browser, then press Enter to resume. ");
      return "resumed";
    } finally {
      prompt.close();
    }
  }

  async request(options: {
    reason: string;
    capabilityId: string;
    stepId?: string;
    approvalAction?: BrowserAction;
    surface: WebSurface;
    evidence: EvidenceRecorder;
  }): Promise<HandoffDisposition> {
    if (this.#controller !== "automation") throw new Error("Cannot transfer a session already controlled by an operator.");

    this.#controller = "operator";
    this.#epoch += 1;
    await options.surface.installOperatorRecorder();
    const screenshot = options.evidence.screenshotPath("intervention");
    await options.surface.screenshot(screenshot);

    const request: InterventionRequest = {
      id: randomUUID(),
      runId: options.evidence.runId,
      reason: options.reason,
      capabilityId: options.capabilityId,
      ...(options.stepId ? { stepId: options.stepId } : {}),
      kind: options.approvalAction ? "approval" : "manual",
      ...(options.approvalAction ? { approval: {
        actionKind: options.approvalAction.kind,
        actionDigest: createHash("sha256").update(JSON.stringify(options.approvalAction)).digest("hex"),
      } } : {}),
      lease: { controller: "operator", epoch: this.#epoch },
      screenshot: options.evidence.relativePath(screenshot),
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      join(options.evidence.directory, "intervention.json"),
      `${JSON.stringify(redactForEvidence(request, options.evidence.sensitiveValues), null, 2)}\n`,
      "utf8",
    );
    await options.evidence.event("intervention_requested", request);
    await options.evidence.event("control_transferred", { from: "automation", to: "operator", epoch: this.#epoch });

    try {
      const response = this.operator
        ? await this.operator(options.surface.page, request)
        : await this.waitForManualResume(request);
      const disposition: HandoffDisposition = options.approvalAction
        ? response === "approved" ? "approved" : "rejected"
        : response === "rejected" ? "rejected" : "resumed";
      const humanActions = await options.surface.collectOperatorActions();
      await options.evidence.event("operator_actions", { count: humanActions.length, actions: humanActions });
      await options.evidence.event("intervention_disposition", { requestId: request.id, disposition });
      return disposition;
    } finally {
      options.surface.stopOperatorRecorder();
      this.#controller = "automation";
      await options.evidence.event("control_transferred", { from: "operator", to: "automation", epoch: this.#epoch });
    }
  }
}
