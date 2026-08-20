import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RequestError,
  type CreateElicitationRequest,
} from "@agentclientprotocol/sdk";
import { handleElicitationRequest } from "./elicitationRequestHandler";
import {
  configureElicitationPersistenceIdentity,
  presentedElicitation,
  useElicitationStore,
} from "../stores/elicitationStore";
import {
  MAX_ELICITATION_DESCRIPTION_BYTES,
  MAX_ELICITATION_MESSAGE_BYTES,
  MAX_ELICITATION_SCHEMA_BYTES,
  MAX_FIELDS,
  MAX_OPTIONS,
} from "../lib/elicitationSchemaLimits";

function headId(sessionId = "session-1"): string {
  const id = presentedElicitation(
    useElicitationStore.getState().pendingBySessionId[sessionId],
  )?.id;
  if (!id) throw new Error(`no pending elicitation for ${sessionId}`);
  return id;
}

const mocks = vi.hoisted(() => ({
  continueRecoveredElicitation: vi.fn().mockResolvedValue(undefined),
  getPreparedProviderId: vi.fn().mockReturnValue("test-provider"),
}));

vi.mock("../lib/recoveredElicitationContinuation", () => ({
  continueRecoveredElicitation: (...args: unknown[]) =>
    mocks.continueRecoveredElicitation(...args),
}));

vi.mock("@/shared/api/acpSessionRegistry", () => ({
  getPreparedProviderId: (...args: unknown[]) =>
    mocks.getPreparedProviderId(...args),
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
    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "workspace-1",
    });
    useElicitationStore.setState({ pendingBySessionId: {} });
  });

  it("queues a form and returns the accepted structured content", async () => {
    const response = handleElicitationRequest(request);
    const store = useElicitationStore.getState();
    expect(store.pendingBySessionId["session-1"]).toHaveLength(1);

    store.setValue("session-1", headId("session-1"), "direction", "local");
    store.accept("session-1", headId("session-1"));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });
  });

  it("attaches provider and connection identity to persisted drafts", () => {
    const response = handleElicitationRequest(request, undefined, 1, {
      connectionGeneration: 3,
      connectionInstanceId: "connection-3",
    });

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0]
        ?.persistenceScope,
    ).toMatchObject({
      providerId: "test-provider",
      connectionGeneration: 3,
      connectionInstanceId: "connection-3",
    });
    useElicitationStore.getState().cancelAll("session-1");
    void response;
  });

  it("cancels and removes a question when its ACP request is aborted", async () => {
    const controller = new AbortController();
    const response = handleElicitationRequest(request, controller.signal);
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toHaveLength(1);

    controller.abort(RequestError.requestCancelled());

    await expect(response).resolves.toEqual({ action: "cancel" });
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("does not let an old transport abort remove a reattached responder", async () => {
    const firstController = new AbortController();
    const first = handleElicitationRequest(
      {
        ...request,
        _meta: { goose: { elicitationId: "question-1" } },
      },
      firstController.signal,
    );
    useElicitationStore.getState().detachAll("session-1");

    const replay = handleElicitationRequest(
      {
        ...request,
        _meta: {
          goose: {
            elicitationId: "question-1",
            recovered: true,
            continuation: "response",
          },
        },
      },
      new AbortController().signal,
    );
    firstController.abort(RequestError.requestCancelled());

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toHaveLength(1);
    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "direction", "local");
    useElicitationStore.getState().accept("session-1", headId("session-1"));
    await expect(replay).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });

    // The disconnected transport's responder is intentionally unreachable.
    void first;
  });

  it("preserves a question when its request signal aborts with the connection", () => {
    const controller = new AbortController();
    const response = handleElicitationRequest(request, controller.signal);

    controller.abort(new Error("ACP connection closed"));

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toHaveLength(1);
    useElicitationStore.getState().detachAll("session-1");
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"][0].resolve,
    ).toBeNull();

    // The disconnected transport's responder is intentionally unreachable.
    void response;
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
    store.setValue("session-1", headId("session-1"), "direction", "local");
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

    useElicitationStore.getState().accept("session-1", headId("session-1"));
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
    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "direction", "issue");
    useElicitationStore.getState().accept("session-1", headId("session-1"));

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

  it("retains failed continuation answers under the provider identity for replay", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.continueRecoveredElicitation.mockRejectedValueOnce(
      new Error("transport unavailable"),
    );
    const recoveredRequest = {
      ...request,
      _meta: {
        goose: {
          elicitationId: "question-retained",
          recovered: true,
          continuation: "prompt",
        },
      },
    } satisfies CreateElicitationRequest;
    const response = handleElicitationRequest(recoveredRequest, undefined, 41, {
      connectionGeneration: 1,
      connectionInstanceId: "connection-before",
    });
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId(), "direction", "issue");
    store.accept("session-1", headId());
    await expect(response).resolves.toMatchObject({ action: "accept" });
    await vi.runAllTimersAsync();

    const retained =
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0];
    expect(retained).toMatchObject({
      content: { direction: "issue" },
      persistenceScope: {
        providerId: "test-provider",
        connectionInstanceId: "connection-before",
      },
      resolve: null,
    });

    const replay = handleElicitationRequest(recoveredRequest, undefined, 99, {
      connectionGeneration: 2,
      connectionInstanceId: "connection-after",
    });
    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      content: { direction: "issue" },
      persistenceScope: {
        providerId: "test-provider",
        connectionInstanceId: "connection-after",
      },
    });
    store.cancel("session-1", queue[0]?.id ?? "");
    await expect(replay).resolves.toEqual({ action: "cancel" });
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it("rejects an unsupported mode as invalid params, not a user cancel", async () => {
    // Answering "cancel" would tell the agent the user declined, when in fact
    // Berd never offered the interaction.
    await expect(
      handleElicitationRequest({
        mode: "url",
        sessionId: "session-1",
        url: "https://example.test/authorize",
      } as unknown as CreateElicitationRequest),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects an unsupported scope as invalid params", async () => {
    await expect(
      handleElicitationRequest({
        mode: "form",
        requestId: "request-1",
        message: "Which direction?",
        requestedSchema: { type: "object", properties: {} },
      } as unknown as CreateElicitationRequest),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects a form with a required field beyond the field limit", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_FIELDS + 1 }, (_, index) => [
        `field-${index}`,
        { type: "string" as const },
      ]),
    );
    await expect(
      handleElicitationRequest({
        ...request,
        requestedSchema: {
          type: "object",
          properties,
          required: [`field-${MAX_FIELDS}`],
        },
      }),
    ).rejects.toMatchObject({
      code: -32602,
      data: { elicitationLimit: { limit: "fields", maximum: MAX_FIELDS } },
    });
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("rejects option lists instead of rendering a truncated answer", async () => {
    await expect(
      handleElicitationRequest({
        ...request,
        requestedSchema: {
          type: "object",
          properties: {
            direction: {
              type: "string",
              enum: Array.from(
                { length: MAX_OPTIONS + 1 },
                (_, index) => `option-${index}`,
              ),
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: -32602,
      data: { elicitationLimit: { limit: "options", maximum: MAX_OPTIONS } },
    });
  });

  it("bounds encoded schema, message, and description sizes", async () => {
    const expectations = [
      handleElicitationRequest({
        ...request,
        message: "m".repeat(MAX_ELICITATION_MESSAGE_BYTES + 1),
      }),
      handleElicitationRequest({
        ...request,
        requestedSchema: {
          type: "object",
          properties: {
            note: {
              type: "string",
              description: "d".repeat(MAX_ELICITATION_DESCRIPTION_BYTES + 1),
            },
          },
        },
      }),
      handleElicitationRequest({
        ...request,
        requestedSchema: {
          type: "object",
          properties: {
            note: {
              type: "string",
              title: "s".repeat(MAX_ELICITATION_SCHEMA_BYTES),
            },
          },
        },
      }),
    ];

    await expect(expectations[0]).rejects.toMatchObject({
      code: -32602,
      data: { elicitationLimit: { limit: "messageBytes" } },
    });
    await expect(expectations[1]).rejects.toMatchObject({
      code: -32602,
      data: { elicitationLimit: { limit: "descriptionBytes" } },
    });
    await expect(expectations[2]).rejects.toMatchObject({
      code: -32602,
      data: { elicitationLimit: { limit: "schemaBytes" } },
    });
  });

  it("keeps two identical questions asked at once distinct", async () => {
    // Without a wire id these hash identically, so one answer would resolve
    // both JSON-RPC requests and the second agent would never be answered.
    const first = handleElicitationRequest(request, undefined, 1);
    const second = handleElicitationRequest(request, undefined, 2);

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(2);
    expect(queue[0]?.id).not.toBe(queue[1]?.id);

    useElicitationStore.getState().accept("session-1", queue[0]?.id ?? "");
    await expect(first).resolves.toMatchObject({ action: "accept" });

    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    useElicitationStore.getState().accept("session-1", queue[1]?.id ?? "");
    await expect(second).resolves.toMatchObject({ action: "accept" });
  });

  it("does not reuse a wire id across independent generation-one clients", async () => {
    void handleElicitationRequest(request, undefined, 41, {
      connectionGeneration: 1,
      connectionInstanceId: "renderer-main",
    });
    useElicitationStore.getState().detachAll("session-1");
    const nextRequest = {
      ...request,
      message: "Choose a different direction",
    } satisfies CreateElicitationRequest;
    const next = handleElicitationRequest(nextRequest, undefined, 41, {
      connectionGeneration: 1,
      connectionInstanceId: "renderer-secondary",
    });

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(2);
    expect(queue[0]?.id).not.toBe(queue[1]?.id);
    expect(queue[0]?.resolve).toBeNull();
    expect(queue[1]?.resolve).not.toBeNull();

    useElicitationStore.getState().cancel("session-1", queue[1]?.id ?? "");
    await expect(next).resolves.toEqual({ action: "cancel" });
  });

  it("requires semantic compatibility even for an exact responder id", async () => {
    const connection = {
      connectionGeneration: 1,
      connectionInstanceId: "same-physical-connection",
    };
    void handleElicitationRequest(request, undefined, 41, connection);
    useElicitationStore.getState().detachAll("session-1");
    const changed = handleElicitationRequest(
      { ...request, message: "Choose a different direction" },
      undefined,
      41,
      connection,
    );

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(2);
    expect(queue[0]?.semanticKey).not.toBe(queue[1]?.semanticKey);
    useElicitationStore.getState().cancel("session-1", queue[1]?.id ?? "");
    await expect(changed).resolves.toEqual({ action: "cancel" });
  });

  it("reattaches a provider-stable question when its wire id changes", async () => {
    const stableRequest = {
      ...request,
      _meta: { goose: { elicitationId: "stable-question" } },
    } satisfies CreateElicitationRequest;
    void handleElicitationRequest(stableRequest, undefined, 41, {
      connectionGeneration: 1,
      connectionInstanceId: "connection-before",
    });
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId(), "direction", "local");
    store.detachAll("session-1");

    const replay = handleElicitationRequest(stableRequest, undefined, 99, {
      connectionGeneration: 2,
      connectionInstanceId: "connection-after",
    });
    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.content).toEqual({ direction: "local" });
    expect(queue[0]?.persistenceScope?.connectionGeneration).toBe(2);

    store.accept("session-1", queue[0]?.id ?? "");
    await expect(replay).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });
  });

  it("reattaches one legacy draft when the replay has no wire id", async () => {
    const first = handleElicitationRequest(request, undefined, 41);
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId(), "direction", "local");
    store.detachAll("session-1");

    const replay = handleElicitationRequest(request);
    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.content).toEqual({ direction: "local" });

    useElicitationStore.getState().accept("session-1", queue[0]?.id ?? "");
    await expect(replay).resolves.toMatchObject({
      action: "accept",
      content: { direction: "local" },
    });
    void first;
  });

  it("keeps ambiguous legacy drafts visible instead of merging them", () => {
    void handleElicitationRequest(request, undefined, 41);
    void handleElicitationRequest(request, undefined, 42);
    useElicitationStore.getState().detachAll("session-1");

    void handleElicitationRequest(request);

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(3);
    expect(queue.filter((pending) => pending.resolve === null)).toHaveLength(2);
    expect(queue.filter((pending) => pending.resolve !== null)).toHaveLength(1);
  });

  it("keeps questions from the same tool call distinct by wire id", () => {
    const toolRequest = { ...request, toolCallId: "tool-call-1" };
    void handleElicitationRequest(toolRequest, undefined, 1);
    void handleElicitationRequest(toolRequest, undefined, 2);

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(2);
    expect(queue[0]?.semanticKey).toBe(queue[1]?.semanticKey);
    expect(queue[0]?.id).not.toBe(queue[1]?.id);
  });

  it("only continues as a prompt when the request is marked recovered", async () => {
    // Continuation is a recovery behaviour; arbitrary metadata must not be able
    // to redirect a live question into an ordinary message.
    vi.useFakeTimers();
    const response = handleElicitationRequest({
      ...request,
      _meta: { goose: { elicitationId: "live-1", continuation: "prompt" } },
    } as typeof request);
    const pending =
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0];
    expect(pending?.continuation).toBe("response");
    useElicitationStore
      .getState()
      .setValue("session-1", "live-1", "direction", "local");
    useElicitationStore.getState().accept("session-1", "live-1");
    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });
    await vi.runAllTimersAsync();
    expect(mocks.continueRecoveredElicitation).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
