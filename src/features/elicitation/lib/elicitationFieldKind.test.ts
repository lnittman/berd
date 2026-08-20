import type { ElicitationPropertySchema } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { elicitationFieldKind } from "./elicitationFieldKind";

const schema = (value: unknown) => value as ElicitationPropertySchema;

describe("elicitationFieldKind", () => {
  it("recognises the controls Berd can render", () => {
    expect(elicitationFieldKind(schema({ type: "string" }))).toBe("scalar");
    expect(elicitationFieldKind(schema({ type: "number" }))).toBe("scalar");
    expect(elicitationFieldKind(schema({ type: "boolean" }))).toBe("boolean");
    expect(
      elicitationFieldKind(
        schema({ type: "string", oneOf: [{ const: "a" }, { const: "b" }] }),
      ),
    ).toBe("single-select");
    expect(
      elicitationFieldKind(
        schema({ type: "array", items: { enum: ["a", "b"] } }),
      ),
    ).toBe("multi-select");
  });

  it("refuses to guess at a type it does not know", () => {
    // A future ACP type must not be shown as a text box; answering it would
    // send the agent a value it never asked for.
    expect(elicitationFieldKind(schema({ type: "object" }))).toBe(
      "unsupported",
    );
    expect(elicitationFieldKind(schema({ type: "colour-picker" }))).toBe(
      "unsupported",
    );
    expect(elicitationFieldKind(schema({}))).toBe("unsupported");
  });

  it("refuses an array whose items are not a known set of strings", () => {
    expect(
      elicitationFieldKind(
        schema({ type: "array", items: { type: "object" } }),
      ),
    ).toBe("unsupported");
    expect(elicitationFieldKind(schema({ type: "array" }))).toBe("unsupported");
  });

  it("treats credential-marked schemas as unsupported in form mode", () => {
    expect(
      elicitationFieldKind(
        schema({
          type: "string",
          _meta: { codex: { isSecret: true } },
        }),
      ),
    ).toBe("unsupported");
  });
});
