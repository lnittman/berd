import { describe, expect, it } from "vitest";
import type { FormElicitationRequest } from "../stores/elicitationStore";
import { recoveredElicitationPrompt } from "./recoveredElicitationContinuation";

const request: FormElicitationRequest = {
  mode: "form",
  sessionId: "session-1",
  message: "Choose the next step",
  requestedSchema: {
    type: "object",
    properties: {
      direction: { type: "string", title: "Direction" },
      direction_custom: { type: "string", title: "Other" },
      surfaces: { type: "array", title: "Surfaces", items: { enum: [] } },
    },
  },
};

describe("recoveredElicitationPrompt", () => {
  it("turns accepted structured answers into one explicit continuation prompt", () => {
    expect(
      recoveredElicitationPrompt(request, {
        action: "accept",
        content: { direction: "local", surfaces: ["desktop", "cli"] },
      }),
    ).toContain("- Direction: local\n- Surfaces: desktop, cli");
  });

  it("continues a decline in prose but leaves cancellation terminal", () => {
    expect(
      recoveredElicitationPrompt(request, { action: "decline" }),
    ).toContain("I declined to answer");
    expect(
      recoveredElicitationPrompt(request, { action: "cancel" }),
    ).toBeNull();
  });

  it("labels a custom Other response with its parent question", () => {
    expect(
      recoveredElicitationPrompt(request, {
        action: "accept",
        content: { direction_custom: "A third way" },
      }),
    ).toContain("- Direction: A third way");
  });

  it("uses shared custom-answer metadata when the companion name has no suffix", () => {
    const markedRequest = {
      ...request,
      requestedSchema: {
        ...request.requestedSchema,
        properties: {
          direction: { type: "string", title: "Direction" },
          bespokeAnswer: {
            type: "string",
            title: "Other",
            _meta: {
              _askUserQuestionCustomAnswer: {
                questionId: "direction",
                isCustomAnswer: true,
              },
            },
          },
        },
      },
    } satisfies FormElicitationRequest;

    expect(
      recoveredElicitationPrompt(markedRequest, {
        action: "accept",
        content: { bespokeAnswer: "A fourth way" },
      }),
    ).toContain("- Direction: A fourth way");
  });

  it("redacts secret answers from prose recovery", () => {
    const secretRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "Access token",
            _meta: { codex: { isSecret: true } },
          },
        },
      },
    } satisfies FormElicitationRequest;
    const prompt = recoveredElicitationPrompt(secretRequest, {
      action: "accept",
      content: { token: "do-not-echo-this" },
    });

    expect(prompt).toContain("- Access token: [redacted]");
    expect(prompt).not.toContain("do-not-echo-this");
  });
});
