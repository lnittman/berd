import { describe, expect, it, vi } from "vitest";
import type { FormElicitationRequest } from "../stores/elicitationStore";
import {
  continueRecoveredElicitation,
  recoveredElicitationPrompt,
} from "./recoveredElicitationContinuation";

const mocks = vi.hoisted(() => ({
  sendPromptInBackground: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/chat/lib/backgroundSend", () => ({
  sendPromptInBackground: (...args: unknown[]) =>
    mocks.sendPromptInBackground(...args),
}));

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

  it("checks delivery ownership at the final reversible prompt boundary", async () => {
    const beforePromptDispatch = vi.fn();

    await continueRecoveredElicitation(
      request,
      { action: "accept", content: { direction: "local" } },
      { beforePromptDispatch },
    );

    expect(mocks.sendPromptInBackground).toHaveBeenCalledWith(
      "session-1",
      expect.stringContaining("- Direction: local"),
      "goose",
      undefined,
      {},
      undefined,
      beforePromptDispatch,
    );
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

  it("defensively redacts marked sensitive answers from prose recovery", () => {
    const sensitiveRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          privateValue: {
            type: "string",
            title: "Private answer",
            _meta: { codex: { isSecret: true } },
          },
        },
      },
    } satisfies FormElicitationRequest;
    const prompt = recoveredElicitationPrompt(sensitiveRequest, {
      action: "accept",
      content: { privateValue: "do-not-echo-this" },
    });

    expect(prompt).toContain("- Private answer: [redacted]");
    expect(prompt).not.toContain("do-not-echo-this");
  });
});
