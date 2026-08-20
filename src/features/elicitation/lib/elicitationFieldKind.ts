import type { ElicitationPropertySchema } from "@agentclientprotocol/sdk";

/**
 * What control, if any, a property may be rendered as.
 *
 * A schema arrives from an agent and may describe something this version of
 * Berd does not understand. Such a field is preserved but must not be shown as
 * a control that misrepresents it — answering a future type through a text box
 * would send the agent a value it never asked for.
 */
export type ElicitationFieldKind =
  | "multi-select"
  | "single-select"
  | "boolean"
  | "scalar"
  | "unsupported";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isSecretElicitationProperty(
  schema: ElicitationPropertySchema,
): boolean {
  const raw = schema as Record<string, unknown>;
  const codex = asRecord(asRecord(raw._meta)?.codex);
  return codex?.isSecret === true;
}

function hasOptions(
  container: Record<string, unknown> | null,
  key: "oneOf" | "anyOf",
): boolean {
  if (!container) return false;
  if (Array.isArray(container.enum)) {
    return container.enum.every((value) => typeof value === "string");
  }
  const options = container[key];
  return (
    Array.isArray(options) &&
    options.length > 0 &&
    options.every(
      (option) =>
        option != null &&
        typeof option === "object" &&
        typeof (option as { const?: unknown }).const === "string",
    )
  );
}

export function elicitationFieldKind(
  schema: ElicitationPropertySchema,
): ElicitationFieldKind {
  const raw = schema as Record<string, unknown>;

  // ACP form mode is only for non-sensitive data. Providers must move marked
  // credential collection to URL mode rather than receiving a disguised text
  // answer through this form.
  if (isSecretElicitationProperty(schema)) return "unsupported";

  if (raw.type === "array") {
    const items =
      raw.items != null && typeof raw.items === "object"
        ? (raw.items as Record<string, unknown>)
        : null;
    // An array whose items are not a known set of strings is not a
    // multi-select, whatever it is.
    return hasOptions(items, "anyOf") ? "multi-select" : "unsupported";
  }

  if (hasOptions(raw, "oneOf")) return "single-select";
  if (raw.type === "boolean") return "boolean";
  if (
    raw.type === "string" ||
    raw.type === "number" ||
    raw.type === "integer"
  ) {
    return "scalar";
  }
  // Includes object, null, and any type introduced after this build.
  return "unsupported";
}

export function isUnsupportedField(schema: ElicitationPropertySchema): boolean {
  return elicitationFieldKind(schema) === "unsupported";
}
