import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { CapabilityArtifact, JsonValue, ParameterDefinition } from "./types.js";

const schema = JSON.parse(
  await readFile(new URL("../../schema/capability.schema.json", import.meta.url), "utf8"),
) as object;
const ajv = new Ajv2020({ allErrors: true, strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
const validateCapability = ajv.compile(schema);

export function assertCapability(value: unknown): asserts value is CapabilityArtifact {
  if (!validateCapability(value)) {
    throw new Error(`Capability artifact is invalid: ${ajv.errorsText(validateCapability.errors, { separator: "\n" })}`);
  }
}

function valueMatches(value: JsonValue, definition: ParameterDefinition): boolean {
  switch (definition.type) {
    case "string":
      return typeof value === "string" && (!definition.pattern || new RegExp(definition.pattern).test(value));
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "money":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

export function assertInputs(
  definitions: Record<string, ParameterDefinition>,
  inputs: Record<string, JsonValue>,
): void {
  for (const [name, definition] of Object.entries(definitions)) {
    const value = inputs[name];
    if (value === undefined) {
      if (definition.required) throw new Error(`Required input is missing: ${name}`);
      continue;
    }
    if (!valueMatches(value, definition)) throw new Error(`Input ${name} does not satisfy type ${definition.type}.`);
  }
  const unknown = Object.keys(inputs).filter((name) => !(name in definitions));
  if (unknown.length > 0) throw new Error(`Unknown inputs: ${unknown.join(", ")}`);
}
