import type { JsonValue } from "../domain/types.js";

const SECRET_KEY = /(authorization|cookie|password|secret|token|api.?key|credential)/i;
const SENSITIVE_KEY = /(member.?id|account|balance|name|email|ssn|input|output|value)/i;
const LOCAL_PATH_KEY = /^(evidenceDir|localPath)$/i;

function redactString(value: string, sensitiveValues: ReadonlySet<string>): string {
  if (sensitiveValues.has(value)) return "[REDACTED:parameter]";
  return value
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED:ssn]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED:email]")
    .replace(/\$\s?\d[\d,]*(?:\.\d{2})?/g, "$[REDACTED:amount]")
    .replace(/\b\d{5,}\b/g, "[REDACTED:identifier]")
    .replace(/(?:sk|key|token)-[A-Za-z0-9_-]{12,}/gi, "[REDACTED:secret]");
}

export function redactForEvidence(
  value: unknown,
  sensitiveValues: ReadonlySet<string> = new Set(),
  key = "",
): JsonValue {
  if (value === null || value === undefined) return null;
  if (LOCAL_PATH_KEY.test(key)) return "[LOCAL_RUN_DIRECTORY]";
  if (SECRET_KEY.test(key)) return "[REDACTED:secret]";
  if (SENSITIVE_KEY.test(key) && !/(kind|strategy|description|name$)/i.test(key)) {
    return `[REDACTED:${key || "field"}]`;
  }
  if (typeof value === "string") {
    return redactString(value, sensitiveValues);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => redactForEvidence(item, sensitiveValues));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactForEvidence(childValue, sensitiveValues, childKey),
      ]),
    );
  }
  return String(value);
}

export function redactObservationText(value: string): string {
  return redactString(value, new Set());
}
