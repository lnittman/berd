/**
 * Bounds on what a provider-authored schema is allowed to make the renderer do.
 *
 * A question arrives from an agent, so its schema is untrusted input. A large
 * but technically valid schema, or a pattern that backtracks catastrophically,
 * must not be able to freeze the window.
 */

/** Maximum number of properties accepted in one form. */
export const MAX_FIELDS = 64;
/** Maximum number of choices accepted in one field. */
export const MAX_OPTIONS = 200;
/** Maximum encoded size of the provider-authored JSON schema. */
export const MAX_ELICITATION_SCHEMA_BYTES = 256 * 1024;
/** Maximum encoded size of the user-facing request message. */
export const MAX_ELICITATION_MESSAGE_BYTES = 32 * 1024;
/** Maximum encoded size of any provider-authored description. */
export const MAX_ELICITATION_DESCRIPTION_BYTES = 8 * 1024;
/** Maximum encoded size of the complete persisted draft collection. */
export const MAX_PERSISTED_ELICITATION_BYTES = 512 * 1024;

export interface ElicitationBoundsViolation {
  limit:
    | "schemaBytes"
    | "messageBytes"
    | "descriptionBytes"
    | "fields"
    | "options";
  maximum: number;
  actual: number;
}

const textEncoder = new TextEncoder();

export function encodedByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedSchemaViolation(
  value: unknown,
): ElicitationBoundsViolation | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const violation = nestedSchemaViolation(item);
      if (violation) return violation;
    }
    return null;
  }

  const record = asRecord(value);
  if (!record) return null;
  for (const [key, child] of Object.entries(record)) {
    if (key === "description" && typeof child === "string") {
      const actual = encodedByteLength(child);
      if (actual > MAX_ELICITATION_DESCRIPTION_BYTES) {
        return {
          limit: "descriptionBytes",
          maximum: MAX_ELICITATION_DESCRIPTION_BYTES,
          actual,
        };
      }
    }
    if (
      (key === "enum" || key === "oneOf" || key === "anyOf") &&
      Array.isArray(child) &&
      child.length > MAX_OPTIONS
    ) {
      return {
        limit: "options",
        maximum: MAX_OPTIONS,
        actual: child.length,
      };
    }
    const violation = nestedSchemaViolation(child);
    if (violation) return violation;
  }
  return null;
}

/** Reject a provider form in full when it exceeds a renderer boundary. */
export function elicitationBoundsViolation(
  message: string,
  schema: unknown,
): ElicitationBoundsViolation | null {
  const messageBytes = encodedByteLength(message);
  if (messageBytes > MAX_ELICITATION_MESSAGE_BYTES) {
    return {
      limit: "messageBytes",
      maximum: MAX_ELICITATION_MESSAGE_BYTES,
      actual: messageBytes,
    };
  }

  let serializedSchema: string;
  try {
    const serialized = JSON.stringify(schema);
    if (serialized === undefined) {
      return {
        limit: "schemaBytes",
        maximum: MAX_ELICITATION_SCHEMA_BYTES,
        actual: 0,
      };
    }
    serializedSchema = serialized;
  } catch {
    return {
      limit: "schemaBytes",
      maximum: MAX_ELICITATION_SCHEMA_BYTES,
      actual: MAX_ELICITATION_SCHEMA_BYTES + 1,
    };
  }
  const schemaBytes = encodedByteLength(serializedSchema);
  if (schemaBytes > MAX_ELICITATION_SCHEMA_BYTES) {
    return {
      limit: "schemaBytes",
      maximum: MAX_ELICITATION_SCHEMA_BYTES,
      actual: schemaBytes,
    };
  }

  const properties = asRecord(asRecord(schema)?.properties);
  const fields = properties ? Object.keys(properties).length : 0;
  if (fields > MAX_FIELDS) {
    return { limit: "fields", maximum: MAX_FIELDS, actual: fields };
  }
  return nestedSchemaViolation(schema);
}

/**
 * Provider patterns are intentionally unevaluable. Native RegExp execution
 * cannot be interrupted, and neither shape heuristics nor checking elapsed time
 * after evaluation creates a real boundary. This remains null until Berd has a
 * non-backtracking engine or a worker it can terminate at a deadline.
 */
export function matchesPattern(pattern: string, value: string): boolean | null {
  void pattern;
  void value;
  return null;
}
