import { beforeEach, describe, expect, it } from "vitest";
import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import {
  type FormElicitationRequest,
  isOtherCompanionField,
  useElicitationStore,
} from "./elicitationStore";

const request = {
  mode: "form",
  sessionId: "session-1",
  message: "Tell me what you need",
  requestedSchema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        title: "Direction",
        oneOf: [
          { const: "local", title: "Local" },
          { const: "upstream", title: "Upstream" },
        ],
      },
      direction__other: {
        type: "string",
        title: "Other",
        _meta: { codex: { isOtherAnswer: true } },
      },
      surfaces: {
        type: "array",
        title: "Surfaces",
        items: { enum: ["desktop", "cli"] },
      },
      notes: { type: "string", title: "Notes" },
    },
    required: ["direction", "surfaces", "notes"],
  },
  _meta: { goose: { elicitationId: "question-1" } },
} satisfies FormElicitationRequest;

function enqueue(
  nextRequest: FormElicitationRequest = request,
): Promise<CreateElicitationResponse> {
  return new Promise((resolve) => {
    useElicitationStore.getState().enqueue({ request: nextRequest, resolve });
  });
}

describe("elicitationStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useElicitationStore.setState({ pendingBySessionId: {} });
  });

  it("treats unknown persisted fields as ordinary fields", () => {
    expect(
      isOtherCompanionField(
        request.requestedSchema.properties,
        "missing_custom",
      ),
    ).toBe(false);
  });

  it("returns single-choice, multiple-choice, and free-text values together", async () => {
    const response = enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", "direction", "local");
    store.setValue("session-1", "surfaces", ["desktop", "cli"]);
    store.setValue("session-1", "notes", "Keep it focused");
    store.accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {
        direction: "local",
        surfaces: ["desktop", "cli"],
        notes: "Keep it focused",
      },
    });
  });

  it("submits an adapter Other companion instead of a conflicting enum value", async () => {
    const response = enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", "direction", undefined);
    store.setValue("session-1", "direction__other", "A hybrid path");
    store.accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction__other: "A hybrid path" },
    });
  });

  it("persists drafts without serializing the live resolver", () => {
    void enqueue();
    useElicitationStore
      .getState()
      .setValue("session-1", "notes", "survive restart");

    const persisted = window.localStorage.getItem(
      "berd:pending-elicitations:v1",
    );
    expect(persisted).toContain("survive restart");
    expect(persisted).not.toContain("resolve");
  });

  it("uses the ACP tool call id to keep otherwise identical questions distinct", () => {
    void enqueue({ ...request, _meta: undefined, toolCallId: "tool-call-1" });
    void enqueue({ ...request, _meta: undefined, toolCallId: "tool-call-2" });

    expect(
      useElicitationStore
        .getState()
        .pendingBySessionId["session-1"].map((pending) => pending.id),
    ).toEqual(["tool:session-1:tool-call-1", "tool:session-1:tool-call-2"]);
  });

  it("lets the user dismiss a detached persisted question", () => {
    void enqueue();
    useElicitationStore.getState().detachAll("session-1");

    useElicitationStore.getState().cancel("session-1");

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("keeps decline distinct from cancel", async () => {
    const response = enqueue();
    useElicitationStore.getState().decline("session-1");
    await expect(response).resolves.toEqual({ action: "decline" });
  });
});
