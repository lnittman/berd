import type {
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { findOtherCompanion } from "@/features/elicitation/stores/elicitationStore";

function stringViolatesSchema(
  value: string,
  schema: Record<string, unknown>,
  minimumLength: number,
): boolean {
  const length = value.trim().length;
  if (length < minimumLength) return true;
  if (typeof schema.maxLength === "number" && length > schema.maxLength) {
    return true;
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) return true;
    } catch {
      // Invalid provider patterns must not make a form impossible to submit.
    }
  }
  return false;
}

export function fieldIncomplete(
  name: string,
  schema: ElicitationPropertySchema,
  properties: Record<string, ElicitationPropertySchema>,
  required: boolean,
  content: Record<string, ElicitationContentValue>,
): boolean {
  const raw = schema as Record<string, unknown>;
  const value = content[name];
  const companion = findOtherCompanion(properties, name);
  const otherValue = companion ? content[companion[0]] : undefined;
  if (typeof otherValue === "string" && value === undefined) {
    const companionSchema = companion?.[1] as Record<string, unknown>;
    const minimum =
      typeof companionSchema.minLength === "number"
        ? companionSchema.minLength
        : 1;
    return stringViolatesSchema(otherValue, companionSchema, minimum);
  }
  if (value === undefined || value === "") return required;
  if (Array.isArray(value)) {
    const minimum =
      typeof raw.minItems === "number" ? raw.minItems : required ? 1 : 0;
    const maximum =
      typeof raw.maxItems === "number"
        ? raw.maxItems
        : Number.POSITIVE_INFINITY;
    return value.length < minimum || value.length > maximum;
  }
  if (typeof value === "string") {
    const minimum =
      typeof raw.minLength === "number" ? raw.minLength : required ? 1 : 0;
    return stringViolatesSchema(value, raw, minimum);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return true;
    if (schema.type === "integer" && !Number.isInteger(value)) return true;
    if (typeof raw.minimum === "number" && value < raw.minimum) return true;
    if (typeof raw.maximum === "number" && value > raw.maximum) return true;
  }
  return false;
}

export function fieldHasAnswer(
  name: string,
  properties: Record<string, ElicitationPropertySchema>,
  content: Record<string, ElicitationContentValue>,
): boolean {
  const value = content[name];
  const companion = findOtherCompanion(properties, name);
  const otherValue = companion ? content[companion[0]] : undefined;
  if (typeof otherValue === "string" && value === undefined) {
    return otherValue.trim().length > 0;
  }
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined;
}
