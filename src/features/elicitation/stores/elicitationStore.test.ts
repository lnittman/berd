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

  it("uses the shared custom-answer marker even when the field name has no known suffix", async () => {
    const sharedMarkerRequest = {
      ...request,
      requestedSchema: {
        ...request.requestedSchema,
        properties: {
          direction: request.requestedSchema.properties.direction,
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
    const response = enqueue(sharedMarkerRequest);

    expect(
      isOtherCompanionField(
        sharedMarkerRequest.requestedSchema.properties,
        "bespokeAnswer",
      ),
    ).toBe(true);
    const store = useElicitationStore.getState();
    store.setValue("session-1", "direction", "local");
    store.setValue("session-1", "bespokeAnswer", "A third path");
    store.accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { bespokeAnswer: "A third path" },
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

  it("never persists secret defaults or live secret answers", () => {
    const secretRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          token: {
            type: "string",
            title: "Access token",
            default: "schema-secret-value",
            _meta: { codex: { isSecret: true } },
          },
          note: { type: "string", title: "Note" },
        },
      },
    } satisfies FormElicitationRequest;
    void enqueue(secretRequest);
    const store = useElicitationStore.getState();

    expect(store.pendingBySessionId["session-1"][0].content).not.toHaveProperty(
      "token",
    );
    store.setValue("session-1", "token", "live-secret-value");
    store.setValue("session-1", "note", "safe draft");

    const persisted = window.localStorage.getItem(
      "berd:pending-elicitations:v1",
    );
    expect(persisted).toContain("safe draft");
    expect(persisted).not.toContain("schema-secret-value");
    expect(persisted).not.toContain("live-secret-value");
  });

  it("revalidates a detached draft against a replayed request schema", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", "direction", "local");
    store.setValue("session-1", "surfaces", ["desktop", "cli"]);
    store.setValue("session-1", "notes", "previously safe");
    store.detachAll("session-1");

    const replayedRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            title: "Direction",
            enum: ["upstream"],
          },
          surfaces: {
            type: "array",
            title: "Surfaces",
            items: { enum: ["cli"] },
          },
          notes: {
            type: "string",
            title: "Notes",
            _meta: { codex: { isSecret: true } },
          },
          confirmation: {
            type: "string",
            title: "Confirmation",
            default: "current request",
          },
        },
      },
    } satisfies FormElicitationRequest;
    const response = enqueue(replayedRequest);

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"][0].content,
    ).toEqual({ surfaces: ["cli"], confirmation: "current request" });

    useElicitationStore
      .getState()
      .setValue("session-1", "notes", "fresh secret");
    useElicitationStore.getState().accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {
        surfaces: ["cli"],
        notes: "fresh secret",
        confirmation: "current request",
      },
    });
  });

  it("never carries a secret answer into a replayed non-secret field", async () => {
    const secretFirstRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          notes: {
            type: "string",
            title: "Notes",
            _meta: { codex: { isSecret: true } },
          },
        },
      },
    } satisfies FormElicitationRequest;
    void enqueue(secretFirstRequest);
    const store = useElicitationStore.getState();
    store.setValue("session-1", "notes", "do not replay");
    store.detachAll("session-1");

    const response = enqueue({
      ...secretFirstRequest,
      requestedSchema: {
        type: "object",
        properties: { notes: { type: "string", title: "Notes" } },
      },
    });

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"][0].content,
    ).toEqual({});
    useElicitationStore.getState().cancel("session-1");
    await expect(response).resolves.toEqual({ action: "cancel" });
  });

  it("never submits unknown or type-incompatible content", async () => {
    const response = enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", "notes", true);
    store.setValue("session-1", "removed-field", "stale answer");
    store.accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {},
    });
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

  it("does not discard a detached answer after its responder reattaches", () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.detachAll("session-1");
    void enqueue();

    expect(store.discardDetached("session-1", "question-1")).toBe(false);
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0]
        ?.resolve,
    ).not.toBeNull();
  });

  it("keeps decline distinct from cancel", async () => {
    const response = enqueue();
    useElicitationStore.getState().decline("session-1");
    await expect(response).resolves.toEqual({ action: "decline" });
  });
});
