import type { BrowserAction, PolicyDefinition, TargetApplication } from "../domain/types.js";

export class PolicyViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PolicyViolation";
    this.code = code;
  }
}

function wildcardMatches(pattern: string, actual: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "i");
  return regex.test(actual);
}

function actionTargetText(action: BrowserAction): string {
  if (!("target" in action)) return "";
  return JSON.stringify(action.target).toLowerCase();
}

export class PolicyGuard {
  constructor(
    private readonly target: TargetApplication,
    private readonly policy: PolicyDefinition,
  ) {}

  assertOrigin(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new PolicyViolation("INVALID_URL", `Policy rejected invalid URL: ${rawUrl}`);
    }

    if (!this.target.allowedOrigins.some((origin) => wildcardMatches(origin, url.origin))) {
      throw new PolicyViolation("ORIGIN_NOT_ALLOWED", `Origin ${url.origin} is not allowlisted.`);
    }
    return url;
  }

  assertUrl(rawUrl: string): void {
    const url = this.assertOrigin(rawUrl);
    if (!this.target.allowedPathPatterns.some((pattern) => new RegExp(pattern).test(url.pathname))) {
      throw new PolicyViolation("ROUTE_NOT_ALLOWED", `Route ${url.pathname} is not allowlisted.`);
    }
  }

  authorize(action: BrowserAction, currentUrl: string, hasHumanApproval = false): void {
    if (!this.policy.allowedActions.includes(action.kind)) {
      throw new PolicyViolation("ACTION_NOT_ALLOWED", `Action ${action.kind} is not allowlisted.`);
    }

    const destination = action.kind === "navigate" ? new URL(action.path, currentUrl).toString() : currentUrl;
    this.assertUrl(destination);

    const targetText = actionTargetText(action);
    const matchesRiskRule = this.policy.riskyTargetPatterns.some((pattern) =>
      new RegExp(pattern, "i").test(targetText),
    );
    const irreversible = action.risk === "irreversible" || matchesRiskRule;
    if (!irreversible) return;

    if (this.policy.irreversibleAction === "block") {
      throw new PolicyViolation("IRREVERSIBLE_BLOCKED", "Irreversible actions are blocked by policy.");
    }
    if (!hasHumanApproval) {
      throw new PolicyViolation(
        "HUMAN_APPROVAL_REQUIRED",
        "This action is classified as irreversible and requires a human approval lease.",
      );
    }
  }
}
