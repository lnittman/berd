import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { handleElicitationRequest } from "./elicitationRequestHandler";
import { useElicitationStore } from "../stores/elicitationStore";

const mocks = vi.hoisted(() => ({
  continueRecoveredElicitation: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/recoveredElicitationContinuation", () => ({
  continueRecoveredElicitation: (...args: unknown[]) =>
    mocks.continueRecoveredElicitation(...args),
}));

const request: CreateElicitationRequest = {
  mode: "form",
  sessionId: "session-1",
  message: "Choose a direction",
  requestedSchema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        oneOf: [
          { const: "local", title: "Local proof" },
          { const: "issue", title: "Upstream issue" },
        ],
      },
    },
    required: ["direction"],
  },
};

describe("handleElicitationRequest", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.continueRecoveredElicitation.mockClear();
    useElicitationStore.setState({ pendingBySessionId: {} });
  });

  it("queues a form and returns the accepted structured content", async () => {
    const response = handleElicitationRequest(request);
    const store = useElicitationStore.getState();
    expect(store.pendingBySessionId["session-1"]).toHaveLength(1);

    store.setValue("session-1", "direction", "local");
    store.accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });
  });

  it("returns cancel for unsupported URL elicitation", async () => {
    await expect(
      handleElicitationRequest({
        mode: "url",
        sessionId: "session-1",
        message: "Authenticate",
        url: "https://example.com",
        elicitationId: "auth-1",
      }),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("resolves every pending request as cancelled on teardown", async () => {
    const first = handleElicitationRequest(request);
    const second = handleElicitationRequest(request);
    useElicitationStore.getState().cancelAll("session-1");
    await expect(Promise.all([first, second])).resolves.toEqual([
      { action: "cancel" },
      { action: "cancel" },
    ]);
  });

  it("preserves a detached draft and reattaches the replayed responder", async () => {
    const first = handleElicitationRequest({
      ...request,
      _meta: { goose: { elicitationId: "question-1" } },
    });
    const store = useElicitationStore.getState();
    store.setValue("session-1", "direction", "local");
    store.detachAll("session-1");

    const replay = handleElicitationRequest({
      ...request,
      _meta: {
        goose: {
          elicitationId: "question-1",
          recovered: true,
          continuation: "response",
        },
      },
    });
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"][0].content,
    ).toEqual({ direction: "local" });

    useElicitationStore.getState().accept("session-1");
    await expect(replay).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });
    expect(mocks.continueRecoveredElicitation).not.toHaveBeenCalled();

    // The disconnected transport's resolver is intentionally left unresolved.
    void first;
  });

  it("continues a full-restart recovery as a normal prompt", async () => {
    vi.useFakeTimers();
    const recoveredRequest = {
      ...request,
      _meta: {
        goose: {
          elicitationId: "question-2",
          recovered: true,
          continuation: "prompt",
        },
      },
    } satisfies CreateElicitationRequest;
    const response = handleElicitationRequest(recoveredRequest);
    useElicitationStore.getState().setValue("session-1", "direction", "issue");
    useElicitationStore.getState().accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction: "issue" },
    });
    await vi.runAllTimersAsync();
    expect(mocks.continueRecoveredElicitation).toHaveBeenCalledWith(
      recoveredRequest,
      { action: "accept", content: { direction: "issue" } },
    );
    vi.useRealTimers();
  });
});
