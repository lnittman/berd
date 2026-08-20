import type {
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { matchesPattern } from "./elicitationSchemaLimits";
import { fieldHasAnswer, fieldIncomplete } from "./elicitationFieldValidation";

const properties = {
  surfaces: {
    type: "array",
    title: "Surfaces",
    items: { anyOf: [{ const: "desktop" }, { const: "web" }] },
    maxItems: 2,
  },
  surfaces__other: {
    type: "string",
    title: "Other",
    minLength: 5,
    _meta: { codex: { isOtherAnswer: true } },
  },
} as unknown as Record<string, ElicitationPropertySchema>;

function incomplete(content: Record<string, ElicitationContentValue>): boolean {
  return fieldIncomplete(
    "surfaces",
    properties.surfaces,
    properties,
    true,
    content,
  );
}

describe("elicitationFieldValidation", () => {
  it("validates the custom answer even when options are also selected", () => {
    // The companion carries its own constraints; selecting an option must not
    // let a custom answer bypass them on the way to the accepted payload.
    expect(incomplete({ surfaces: ["desktop"], surfaces__other: "ab" })).toBe(
      true,
    );
    expect(
      incomplete({ surfaces: ["desktop"], surfaces__other: "internal API" }),
    ).toBe(false);
  });

  it("treats a checked but empty custom answer as unfinished", () => {
    expect(incomplete({ surfaces: ["desktop"], surfaces__other: "" })).toBe(
      true,
    );
  });

  it("accepts a custom answer as the only answer to a required field", () => {
    expect(incomplete({ surfaces: [], surfaces__other: "internal API" })).toBe(
      false,
    );
  });

  it("counts the custom answer against maxItems", () => {
    expect(
      incomplete({ surfaces: ["desktop", "web"], surfaces__other: "an API" }),
    ).toBe(true);
    expect(incomplete({ surfaces: ["desktop", "web"] })).toBe(false);
  });

  it("still requires an answer when nothing is chosen", () => {
    expect(incomplete({ surfaces: [] })).toBe(true);
    expect(incomplete({})).toBe(true);
  });

  it("reports a custom-only answer as answered for step progress", () => {
    expect(
      fieldHasAnswer("surfaces", properties, {
        surfaces: [],
        surfaces__other: "internal API",
      }),
    ).toBe(true);
    expect(fieldHasAnswer("surfaces", properties, { surfaces: [] })).toBe(
      false,
    );
  });
});

describe("provider-supplied patterns", () => {
  it("treats every provider pattern as unevaluable", () => {
    expect(matchesPattern("^[a-z]+$", "Berd 1")).toBeNull();
    expect(matchesPattern("([unclosed", "anything")).toBeNull();
  });

  it("never starts ambiguous alternation or nested quantifiers", () => {
    const started = performance.now();
    expect(matchesPattern("^(a+)+$", `${"a".repeat(30)}b`)).toBeNull();
    expect(matchesPattern("^(a|aa)*$", `${"a".repeat(30)}b`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("never validates only a prefix of an over-long value", () => {
    const value = `${"a".repeat(4096)}!`;
    expect(matchesPattern("^a+$", value)).toBeNull();
  });
});
