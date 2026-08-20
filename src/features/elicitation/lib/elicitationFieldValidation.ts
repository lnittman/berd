import type {
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { isUnsupportedField } from "@/features/elicitation/lib/elicitationFieldKind";
import { matchesPattern } from "@/features/elicitation/lib/elicitationSchemaLimits";
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
    // Null means the pattern could not be evaluated within its budget, which
    // must not be read as a failed value or the form becomes unanswerable.
    if (matchesPattern(schema.pattern, value) === false) return true;
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
  // A field Berd cannot render cannot be answered, so a required one blocks
  // acceptance rather than being silently submitted as empty.
  if (isUnsupportedField(schema)) return required;
  const raw = schema as Record<string, unknown>;
  const value = content[name];
  const companion = findOtherCompanion(properties, name);
  const otherValue = companion ? content[companion[0]] : undefined;
  // A companion string is present only while "Other" is checked, so an empty
  // one means the user asked for a custom answer and has not written it yet.
  const customChecked = typeof otherValue === "string";
  if (customChecked) {
    const companionSchema = companion?.[1] as Record<string, unknown>;
    const minimum =
      typeof companionSchema.minLength === "number"
        ? companionSchema.minLength
        : 1;
    if (stringViolatesSchema(otherValue, companionSchema, minimum)) return true;
  }

  if (raw.type === "array") {
    // A custom answer sits alongside the checked options rather than replacing
    // them, so it counts as one more item against minItems/maxItems.
    const selected = Array.isArray(value) ? value.length : 0;
    const custom = customChecked && otherValue.trim() ? 1 : 0;
    const total = selected + custom;
    const minimum =
      typeof raw.minItems === "number" ? raw.minItems : required ? 1 : 0;
    const maximum =
      typeof raw.maxItems === "number"
        ? raw.maxItems
        : Number.POSITIVE_INFINITY;
    return total < minimum || total > maximum;
  }

  if (customChecked && value === undefined) return false;
  if (value === undefined || value === "") return required;
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
  if (typeof otherValue === "string" && otherValue.trim().length > 0) {
    return true;
  }
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined;
}
