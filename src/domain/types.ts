export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ParameterType = "string" | "integer" | "number" | "boolean" | "money";
export type RiskLevel = "safe" | "reversible" | "irreversible";
export type ActionKind = "navigate" | "click" | "type" | "extract";

export interface ParameterDefinition {
  type: ParameterType;
  description: string;
  required: boolean;
  sensitive?: boolean;
  pattern?: string;
}

export interface OutputDefinition {
  type: ParameterType;
  description: string;
  sensitive?: boolean;
}

export interface FrameTarget {
  name?: string;
  urlPattern?: string;
}

export type LocatorDefinition =
  | { strategy: "role"; role: string; name: string; exact?: boolean }
  | { strategy: "label"; label: string; exact?: boolean }
  | { strategy: "text"; text: string; exact?: boolean }
  | { strategy: "css"; selector: string };

export interface TargetDefinition {
  frame?: FrameTarget;
  primary: LocatorDefinition;
  fallbacks?: LocatorDefinition[];
  fingerprint?: {
    tag?: string;
    controlType?: string;
    nearbyText?: string;
  };
  rationale?: string;
}

export type ValueExpression =
  | { kind: "literal"; value: string }
  | { kind: "parameter"; name: string };

export type BrowserAction =
  | { kind: "navigate"; path: string; risk: RiskLevel }
  | { kind: "click"; target: TargetDefinition; risk: RiskLevel }
  | {
      kind: "type";
      target: TargetDefinition;
      value: ValueExpression;
      clear: boolean;
      risk: RiskLevel;
    }
  | {
      kind: "extract";
      target: TargetDefinition;
      output: string;
      parseAs: ParameterType;
      risk: RiskLevel;
    };

export type Condition =
  | { kind: "visible" | "not_visible"; target: TargetDefinition }
  | { kind: "text_matches"; target: TargetDefinition; pattern: string }
  | { kind: "url_matches"; pattern: string };

export interface CapabilityStep {
  id: string;
  description: string;
  action: BrowserAction;
  timeoutMs: number;
  retry: { maxAttempts: number; backoffMs: number };
  postcondition?: Condition;
}

export type ExceptionClass =
  | "business_outcome"
  | "recoverable"
  | "human_required"
  | "hard_failure";

export interface ExceptionRule {
  id: string;
  classification: ExceptionClass;
  code: string;
  message: string;
  when: Condition;
  recovery?: BrowserAction[];
  maxRecoveries?: number;
}

export interface TargetApplication {
  surface: "web";
  appId: string;
  entrypoint: string;
  allowedOrigins: string[];
  allowedPathPatterns: string[];
  redactSelectors: string[];
}

export interface PolicyDefinition {
  allowedActions: ActionKind[];
  irreversibleAction: "block" | "human_approval";
  riskyTargetPatterns: string[];
}

export interface CompatibilityDefinition {
  vendorProduct: string;
  testedVersions: string[];
  uiFingerprint: string;
  tenantOverrides?: Record<
    string,
    {
      entrypoint?: string;
      locatorOverrides?: Record<string, TargetDefinition>;
    }
  >;
}

export interface CapabilityContract {
  goalTemplate: string;
  inputs: Record<string, ParameterDefinition>;
  outputs: Record<string, OutputDefinition>;
  businessOutcomes: Array<{ code: string; description: string }>;
}

export interface CapabilityArtifact {
  schemaVersion: "1.0.0";
  capability: {
    id: string;
    name: string;
    version: string;
    description: string;
    approval: "draft" | "approved";
  };
  target: TargetApplication;
  compatibility: CompatibilityDefinition;
  contract: CapabilityContract;
  policy: PolicyDefinition;
  steps: CapabilityStep[];
  exceptionRules: ExceptionRule[];
  checkpoint: Condition;
  provenance: {
    sourceRunId: string;
    discoveredAt: string;
    provider: string;
    model: string;
  };
}

export interface DiscoverySpec {
  capability: Omit<CapabilityArtifact["capability"], "version" | "approval">;
  target: TargetApplication;
  compatibility: CompatibilityDefinition;
  contract: CapabilityContract;
  policy: PolicyDefinition;
  exceptionRules: ExceptionRule[];
  checkpoint: Condition;
}

export interface ObservedControl {
  tag: string;
  role: string;
  name: string;
  label?: string;
  placeholder?: string;
  type?: string;
  disabled: boolean;
}

export interface FrameObservation {
  name: string;
  url: string;
  title: string;
  text: string;
  controls: ObservedControl[];
}

export interface SurfaceObservation {
  url: string;
  title: string;
  frames: FrameObservation[];
}

export type ModelAction =
  | {
      kind: "click";
      description: string;
      target: { frame?: FrameTarget; locator: LocatorDefinition };
      risk: RiskLevel;
      rationale: string;
    }
  | {
      kind: "type";
      description: string;
      target: { frame?: FrameTarget; locator: LocatorDefinition };
      value: ValueExpression;
      risk: RiskLevel;
      rationale: string;
    }
  | {
      kind: "extract";
      description: string;
      target: { frame?: FrameTarget; locator: LocatorDefinition };
      output: string;
      parseAs: ParameterType;
      risk: RiskLevel;
      rationale: string;
    }
  | { kind: "finish"; summary: string; rationale: string }
  | { kind: "escalate"; reason: string; rationale: string };

export interface InterventionRequest {
  id: string;
  runId: string;
  reason: string;
  capabilityId: string;
  stepId?: string;
  kind: "manual" | "approval";
  approval?: { actionKind: ActionKind; actionDigest: string };
  lease: { controller: "operator"; epoch: number };
  screenshot?: string;
  createdAt: string;
}

export interface RunFailure {
  code: string;
  classification: "policy" | "timeout" | "target" | "checkpoint" | "application";
  message: string;
  stepId?: string;
  expected?: string;
  observed?: string;
  retryable: boolean;
  evidenceRef?: string;
}

export type RunResult =
  | {
      status: "success";
      runId: string;
      capabilityId: string;
      outputs: Record<string, JsonValue>;
      evidenceDir: string;
    }
  | {
      status: "business_outcome";
      runId: string;
      capabilityId: string;
      outcome: { code: string; message: string };
      evidenceDir: string;
    }
  | {
      status: "failure";
      runId: string;
      capabilityId: string;
      error: RunFailure;
      evidenceDir: string;
    };
