import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import {
  ELICITATION_STORAGE_KEY,
  type FormElicitationRequest,
  clearPersistedElicitations,
  configureElicitationPersistenceIdentity,
  flushElicitationDrafts,
  getElicitationPersistenceScope,
  loadPersistedForTests,
  presentedElicitation,
  isOtherCompanionField,
  suspendElicitationPersistence,
  useElicitationStore,
} from "./elicitationStore";
import { MAX_PERSISTED_ELICITATION_BYTES } from "../lib/elicitationSchemaLimits";

function headId(sessionId = "session-1"): string {
  const id = presentedElicitation(
    useElicitationStore.getState().pendingBySessionId[sessionId],
  )?.id;
  if (!id) throw new Error(`no pending elicitation for ${sessionId}`);
  return id;
}

function persistedQueues(): Record<string, Array<{ savedAt: number }>> {
  const raw = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
  if (!raw) return {};
  return JSON.parse(raw).scopes[0]?.queues ?? {};
}

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
    vi.useFakeTimers();
    clearPersistedElicitations();
    window.localStorage.clear();
    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "workspace-1",
    });
    useElicitationStore.setState({ pendingBySessionId: {} });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
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
    store.setValue("session-1", headId("session-1"), "direction", "local");
    store.setValue("session-1", headId("session-1"), "surfaces", [
      "desktop",
      "cli",
    ]);
    store.setValue(
      "session-1",
      headId("session-1"),
      "notes",
      "Keep it focused",
    );
    store.accept("session-1", headId("session-1"));

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
    store.setValue("session-1", headId("session-1"), "direction", undefined);
    store.setValue(
      "session-1",
      headId("session-1"),
      "direction__other",
      "A hybrid path",
    );
    store.accept("session-1", headId("session-1"));

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
    store.setValue("session-1", headId("session-1"), "direction", "local");
    store.setValue(
      "session-1",
      headId("session-1"),
      "bespokeAnswer",
      "A third path",
    );
    store.accept("session-1", headId("session-1"));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { bespokeAnswer: "A third path" },
    });
  });

  it("persists drafts without serializing the live resolver", () => {
    void enqueue();
    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "notes", "survive restart");
    vi.runOnlyPendingTimers();

    const persisted = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
    expect(persisted).toContain("survive restart");
    expect(persisted).not.toContain("resolve");
  });

  it("namespaces drafts by account, workspace, provider, and physical connection", () => {
    const firstScope = getElicitationPersistenceScope(
      "provider-a",
      7,
      "connection-a",
    );
    expect(firstScope).not.toBeNull();
    void new Promise((resolve) => {
      useElicitationStore.getState().enqueue({
        request,
        resolve,
        persistenceScope: firstScope,
      });
    });
    useElicitationStore
      .getState()
      .setValue("session-1", headId(), "notes", "scoped answer");
    vi.runOnlyPendingTimers();

    const persisted =
      window.localStorage.getItem(ELICITATION_STORAGE_KEY) ?? "";
    const envelope = JSON.parse(persisted);
    expect(envelope).toMatchObject({
      version: 4,
      scopes: [
        {
          identity: {
            providerId: "provider-a",
            connectionGeneration: 7,
            connectionInstanceId: "connection-a",
          },
        },
      ],
    });
    expect(persisted).not.toContain("account-1");
    expect(persisted).not.toContain("workspace-1");

    configureElicitationPersistenceIdentity({
      accountId: "account-2",
      workspaceId: "workspace-1",
    });
    expect(
      loadPersistedForTests(
        getElicitationPersistenceScope("provider-a", 7, "connection-a"),
      ),
    ).toEqual({});

    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "workspace-2",
    });
    expect(
      loadPersistedForTests(
        getElicitationPersistenceScope("provider-a", 7, "connection-a"),
      ),
    ).toEqual({});

    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "workspace-1",
    });
    expect(
      loadPersistedForTests(
        getElicitationPersistenceScope("provider-b", 7, "connection-a"),
      ),
    ).toEqual({});

    const recovered = loadPersistedForTests(
      getElicitationPersistenceScope("provider-a", 8, "connection-b"),
    );
    expect(recovered["session-1"]?.[0]).toMatchObject({
      content: { notes: "scoped answer" },
      persistenceScope: {
        providerId: "provider-a",
        connectionGeneration: 7,
        connectionInstanceId: "connection-a",
      },
    });
  });

  it("keeps known FNV-colliding workspace identifiers in separate scopes", () => {
    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "ws-1o9b2ct-jgnobg",
    });
    const first = getElicitationPersistenceScope("provider-a", 1);
    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "ws-iamgk3-8jcmra",
    });
    const second = getElicitationPersistenceScope("provider-a", 1);

    expect(first?.workspaceId).not.toBe(second?.workspaceId);
  });

  it("hydrates equal request ids from separate connection scopes without deleting either", () => {
    const firstScope = getElicitationPersistenceScope("provider-a", 7);
    const secondScope = getElicitationPersistenceScope("provider-a", 8);
    const incomingScope = getElicitationPersistenceScope("provider-a", 9);
    if (!firstScope || !secondScope || !incomingScope) {
      throw new Error("expected configured persistence scopes");
    }
    void new Promise((resolve) => {
      useElicitationStore.getState().enqueue({
        request,
        resolve,
        persistenceScope: firstScope,
      });
    });
    vi.runOnlyPendingTimers();
    const envelope = JSON.parse(
      window.localStorage.getItem(ELICITATION_STORAGE_KEY) ?? "{}",
    );
    envelope.scopes.push({
      identity: secondScope,
      queues: envelope.scopes[0].queues,
    });
    window.localStorage.setItem(
      ELICITATION_STORAGE_KEY,
      JSON.stringify(envelope),
    );
    useElicitationStore.setState({ pendingBySessionId: {} });

    const hydrated = loadPersistedForTests(incomingScope);

    expect(hydrated["session-1"]).toHaveLength(2);
    expect(
      hydrated["session-1"]
        .map((pending) => pending.persistenceScope?.connectionGeneration)
        .sort(),
    ).toEqual([7, 8]);
  });

  it("preserves persisted provider scopes that have not been hydrated", () => {
    const providerAScope = getElicitationPersistenceScope("provider-a", 7);
    const providerBScope = getElicitationPersistenceScope("provider-b", 7);
    if (!providerAScope || !providerBScope) {
      throw new Error("expected configured persistence scopes");
    }

    void new Promise((resolve) => {
      useElicitationStore.getState().enqueue({
        request,
        resolve,
        persistenceScope: providerAScope,
      });
    });
    void new Promise((resolve) => {
      useElicitationStore.getState().enqueue({
        request: {
          ...request,
          sessionId: "session-2",
          _meta: { goose: { elicitationId: "question-2" } },
        },
        resolve,
        persistenceScope: providerBScope,
      });
    });
    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "notes", "provider a");
    useElicitationStore
      .getState()
      .setValue("session-2", headId("session-2"), "notes", "provider b");
    vi.runOnlyPendingTimers();

    const persisted = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
    expect(persisted).not.toBeNull();

    // Simulate an app restart that only reconnects provider A. Persisting its
    // recovered queue must not erase provider B's unhydrated namespace.
    suspendElicitationPersistence();
    configureElicitationPersistenceIdentity({
      accountId: "other-account",
      workspaceId: "workspace-1",
    });
    configureElicitationPersistenceIdentity({
      accountId: "account-1",
      workspaceId: "workspace-1",
    });
    useElicitationStore.setState({ pendingBySessionId: {} });
    window.localStorage.setItem(ELICITATION_STORAGE_KEY, persisted ?? "");
    useElicitationStore.setState({
      pendingBySessionId: loadPersistedForTests(providerAScope),
    });
    vi.runOnlyPendingTimers();

    const rewritten = JSON.parse(
      window.localStorage.getItem(ELICITATION_STORAGE_KEY) ?? "{}",
    );
    expect(
      rewritten.scopes
        .map(
          (scope: { identity: { providerId: string } }) =>
            scope.identity.providerId,
        )
        .sort(),
    ).toEqual(["provider-a", "provider-b"]);
    expect(
      rewritten.scopes.find(
        (scope: { identity: { providerId: string } }) =>
          scope.identity.providerId === "provider-b",
      )?.queues["session-2"][0].content,
    ).toEqual({ notes: "provider b" });
  });

  it("removes persistence when the complete draft collection exceeds its byte budget", () => {
    void enqueue();
    vi.runOnlyPendingTimers();
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).not.toBeNull();

    useElicitationStore
      .getState()
      .setValue(
        "session-1",
        headId("session-1"),
        "notes",
        "x".repeat(MAX_PERSISTED_ELICITATION_BYTES),
      );
    vi.runOnlyPendingTimers();

    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toBeNull();
  });

  it("drops credential-marked defaults and stale answers", async () => {
    const credentialRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          credential: {
            type: "string",
            title: "Credential",
            default: "provider-credential-value",
            _meta: { codex: { isSecret: true } },
          },
          note: { type: "string", title: "Note" },
        },
      },
    } satisfies FormElicitationRequest;
    const response = enqueue(credentialRequest);
    const store = useElicitationStore.getState();

    expect(store.pendingBySessionId["session-1"][0].content).not.toHaveProperty(
      "credential",
    );
    store.setValue(
      "session-1",
      headId("session-1"),
      "credential",
      "stale-credential-value",
    );
    store.setValue("session-1", headId("session-1"), "note", "safe draft");
    vi.runOnlyPendingTimers();

    const persisted = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
    expect(persisted).toContain("safe draft");
    expect(persisted).not.toContain("provider-credential-value");
    expect(persisted).not.toContain("stale-credential-value");

    store.accept("session-1", headId("session-1"));
    await expect(response).resolves.toEqual({
      action: "accept",
      content: { note: "safe draft" },
    });
  });

  it("drops hidden companion values when their parent is a credential field", async () => {
    const credentialRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          credential: {
            type: "string",
            title: "Credential",
            _meta: { codex: { isSecret: true } },
          },
          credential__other: {
            type: "string",
            title: "Other",
            default: "provider-companion-value",
            _meta: {
              codex: { isOtherAnswer: true, questionId: "credential" },
            },
          },
        },
      },
    } satisfies FormElicitationRequest;
    const response = enqueue(credentialRequest);
    const store = useElicitationStore.getState();

    expect(store.pendingBySessionId["session-1"][0].content).toEqual({});
    store.setValue(
      "session-1",
      headId("session-1"),
      "credential__other",
      "stale-companion-value",
    );
    vi.runOnlyPendingTimers();
    const persisted = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
    expect(persisted).not.toContain("provider-companion-value");
    expect(persisted).not.toContain("stale-companion-value");

    store.accept("session-1", headId("session-1"));
    await expect(response).resolves.toEqual({
      action: "accept",
      content: {},
    });
  });

  it("revalidates a detached draft against a replayed request schema", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId("session-1"), "direction", "local");
    store.setValue("session-1", headId("session-1"), "surfaces", [
      "desktop",
      "cli",
    ]);
    store.setValue(
      "session-1",
      headId("session-1"),
      "notes",
      "previously safe",
    );
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
          notes: { type: "integer", title: "Priority" },
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
      .setValue("session-1", headId("session-1"), "notes", 7);
    useElicitationStore.getState().accept("session-1", headId("session-1"));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {
        surfaces: ["cli"],
        notes: 7,
        confirmation: "current request",
      },
    });
  });

  it("never carries an unsupported credential answer into an ordinary replay", async () => {
    const credentialFirstRequest = {
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
    void enqueue(credentialFirstRequest);
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId("session-1"), "notes", "do not replay");
    store.detachAll("session-1");

    const response = enqueue({
      ...credentialFirstRequest,
      requestedSchema: {
        type: "object",
        properties: { notes: { type: "string", title: "Notes" } },
      },
    });

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"][0].content,
    ).toEqual({});
    useElicitationStore.getState().cancel("session-1", headId("session-1"));
    await expect(response).resolves.toEqual({ action: "cancel" });
  });

  it("never submits unknown or type-incompatible content", async () => {
    const response = enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId("session-1"), "notes", true);
    store.setValue(
      "session-1",
      headId("session-1"),
      "removed-field",
      "stale answer",
    );
    store.accept("session-1", headId("session-1"));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {},
    });
  });

  it("drops provider defaults and stale answers for unsupported fields", async () => {
    const unsupportedRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          visual: {
            type: "colour-picker",
            title: "Visual",
            default: "provider-default",
          },
          notes: { type: "string", title: "Notes" },
        },
      },
    } as unknown as FormElicitationRequest;
    const response = enqueue(unsupportedRequest);
    const store = useElicitationStore.getState();

    expect(store.pendingBySessionId["session-1"][0].content).toEqual({});
    store.setValue(
      "session-1",
      headId("session-1"),
      "visual",
      "stale persisted answer",
    );
    store.setValue("session-1", headId("session-1"), "notes", "Visible");
    store.accept("session-1", headId("session-1"));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { notes: "Visible" },
    });
  });

  it("uses the ACP tool call id as part of legacy semantic identity", () => {
    void enqueue({ ...request, _meta: undefined, toolCallId: "tool-call-1" });
    void enqueue({ ...request, _meta: undefined, toolCallId: "tool-call-2" });

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(2);
    expect(queue[0]?.semanticKey).not.toBe(queue[1]?.semanticKey);
  });

  it("lets the user dismiss a detached persisted question", () => {
    void enqueue();
    useElicitationStore.getState().detachAll("session-1");

    useElicitationStore.getState().cancel("session-1", headId("session-1"));

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("does not discard a detached answer after its responder reattaches", () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.detachAll("session-1");
    void enqueue();

    // A question whose responder came back cannot be sent as an ordinary
    // message: the claim is refused, so the live path keeps ownership.
    expect(
      useElicitationStore
        .getState()
        .claimDetachedDelivery("session-1", "question-1"),
    ).toBeNull();
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0]
        ?.resolve,
    ).not.toBeNull();
  });

  it("keeps decline distinct from cancel", async () => {
    const response = enqueue();
    useElicitationStore.getState().decline("session-1", headId("session-1"));
    await expect(response).resolves.toEqual({ action: "decline" });
  });

  it("ignores a submit addressed to a question that is no longer the head", async () => {
    const first = enqueue();
    const second = enqueue({
      ...request,
      _meta: { goose: { elicitationId: "question-2" } },
    });

    // The agent withdraws the question the user was reading. A click already
    // on its way must not answer the one that moved up behind it.
    useElicitationStore.getState().cancel("session-1", "question-1");
    await expect(first).resolves.toEqual({ action: "cancel" });

    useElicitationStore.getState().accept("session-1", "question-1");
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    useElicitationStore.getState().accept("session-1", "question-2");
    await expect(second).resolves.toMatchObject({ action: "accept" });
  });

  it("keeps each draft's own age when another session is written", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    void enqueue();
    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "notes", "first");
    vi.runOnlyPendingTimers();
    const firstSavedAt = persistedQueues()["session-1"][0].savedAt;

    vi.setSystemTime(new Date("2026-01-20T00:00:00Z"));
    void enqueue({
      ...request,
      sessionId: "session-2",
      _meta: { goose: { elicitationId: "question-2" } },
    });
    useElicitationStore
      .getState()
      .setValue("session-2", headId("session-2"), "notes", "second");
    vi.runOnlyPendingTimers();

    expect(persistedQueues()["session-1"][0].savedAt).toBe(firstSavedAt);
  });

  it("writes a debounced draft immediately when the window goes away", () => {
    void enqueue();
    vi.runOnlyPendingTimers();
    window.localStorage.clear();

    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "notes", "unsaved");
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toBeNull();

    flushElicitationDrafts();
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toContain(
      "unsaved",
    );
  });

  it("shows a live question that arrives behind a recovered draft", async () => {
    // A recovered draft nobody is waiting on must never hide a request the
    // agent is actually blocked on, or the turn stalls with a usable composer.
    useElicitationStore.setState({
      pendingBySessionId: {
        "session-1": [
          {
            id: "recovered-1",
            semanticKey: "goose:session-1:recovered-1",
            wireRequestId: null,
            request: {
              ...request,
              _meta: { goose: { elicitationId: "recovered-1" } },
            },
            content: {},
            step: 0,
            recovered: true,
            continuation: "prompt",
            resolve: null,
            responderKey: null,
            deliveryClaim: null,
            persistenceScope: null,
            savedAt: Date.now(),
          },
        ],
      },
    });

    const live = enqueue({
      ...request,
      _meta: { goose: { elicitationId: "live-1" } },
    });

    const queue = () =>
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue().map((pending) => pending.id)).toEqual([
      "recovered-1",
      "live-1",
    ]);
    expect(presentedElicitation(queue())?.id).toBe("live-1");

    // Edits and answers address the live question, not the draft in front of it.
    useElicitationStore
      .getState()
      .setValue("session-1", headId("session-1"), "notes", "answered");
    expect(queue().find((p) => p.id === "live-1")?.content.notes).toBe(
      "answered",
    );
    expect(
      queue().find((p) => p.id === "recovered-1")?.content.notes,
    ).toBeUndefined();

    useElicitationStore.getState().accept("session-1", "live-1");
    await expect(live).resolves.toMatchObject({ action: "accept" });

    // The draft survives and becomes presented again once nothing is live.
    expect(queue().map((pending) => pending.id)).toEqual(["recovered-1"]);
    expect(presentedElicitation(queue())?.id).toBe("recovered-1");
  });

  it("ignores an edit from a question that is no longer presented", async () => {
    // A control belonging to a withdrawn question can still fire before React
    // replaces the DOM; that event must not land on its replacement.
    const first = enqueue();
    const second = enqueue({
      ...request,
      _meta: { goose: { elicitationId: "question-2" } },
    });

    useElicitationStore.getState().cancel("session-1", "question-1");
    await expect(first).resolves.toEqual({ action: "cancel" });

    useElicitationStore
      .getState()
      .setValue("session-1", "question-1", "notes", "stale edit");
    useElicitationStore.getState().setStep("session-1", "question-1", 2);

    const presented = presentedElicitation(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    );
    expect(presented?.id).toBe("question-2");
    expect(presented?.content.notes).toBeUndefined();
    expect(presented?.step).toBe(0);

    useElicitationStore.getState().cancel("session-1", "question-2");
    await expect(second).resolves.toEqual({ action: "cancel" });
  });

  it("lets a responder that reattaches before prompt dispatch win", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId(), "notes", "the answer");
    store.detachAll("session-1");

    const token = useElicitationStore
      .getState()
      .claimDetachedDelivery("session-1", "question-1");
    expect(token).not.toBeNull();

    // A second send, or a discard, cannot start while the claim is held.
    expect(
      useElicitationStore
        .getState()
        .claimDetachedDelivery("session-1", "question-1"),
    ).toBeNull();
    useElicitationStore.getState().cancel("session-1", "question-1");
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toHaveLength(1);

    const reattached = enqueue();
    expect(
      useElicitationStore
        .getState()
        .beginDetachedDelivery("session-1", "question-1", token as symbol),
    ).toBe(false);

    await expect(reattached).resolves.toMatchObject({ action: "accept" });
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("cancels a responder that reattaches after prompt dispatch", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.setValue("session-1", headId(), "notes", "the answer");
    store.detachAll("session-1");
    const token = store.claimDetachedDelivery(
      "session-1",
      "question-1",
    ) as symbol;

    expect(
      useElicitationStore
        .getState()
        .beginDetachedDelivery("session-1", "question-1", token),
    ).toBe(true);
    const reattached = enqueue();
    useElicitationStore
      .getState()
      .completeDetachedDelivery("session-1", "question-1", token);

    await expect(reattached).resolves.toEqual({ action: "cancel" });
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("never reopens delivery when the prompt result is unknown after dispatch", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.detachAll("session-1");
    const token = store.claimDetachedDelivery(
      "session-1",
      "question-1",
    ) as symbol;
    expect(store.beginDetachedDelivery("session-1", "question-1", token)).toBe(
      true,
    );

    expect(
      useElicitationStore
        .getState()
        .failDetachedDelivery("session-1", "question-1", token),
    ).toBe("indeterminate");
    const reattached = enqueue();

    await expect(reattached).resolves.toEqual({ action: "cancel" });
    expect(
      useElicitationStore
        .getState()
        .claimDetachedDelivery("session-1", "question-1"),
    ).toBeNull();
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0]
        ?.deliveryClaim,
    ).toMatchObject({ phase: "indeterminate" });

    useElicitationStore.getState().cancelAll("session-1");
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("settles but retains an in-flight delivery until teardown completes", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.detachAll("session-1");
    const token = store.claimDetachedDelivery(
      "session-1",
      "question-1",
    ) as symbol;
    expect(
      useElicitationStore
        .getState()
        .beginDetachedDelivery("session-1", "question-1", token),
    ).toBe(true);
    const reattached = enqueue();

    useElicitationStore.getState().cancelAll("session-1");

    await expect(reattached).resolves.toEqual({ action: "cancel" });
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0]
        ?.deliveryClaim,
    ).toMatchObject({ phase: "prompt-dispatched", cancelled: true });

    useElicitationStore
      .getState()
      .completeDetachedDelivery("session-1", "question-1", token);
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("settles an in-flight responder before account persistence is cleared", async () => {
    void enqueue();
    const store = useElicitationStore.getState();
    store.detachAll("session-1");
    const token = store.claimDetachedDelivery(
      "session-1",
      "question-1",
    ) as symbol;
    expect(
      useElicitationStore
        .getState()
        .beginDetachedDelivery("session-1", "question-1", token),
    ).toBe(true);
    const reattached = enqueue();

    clearPersistedElicitations();

    await expect(reattached).resolves.toEqual({ action: "cancel" });
    expect(window.localStorage.length).toBe(0);
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"]?.[0]
        ?.deliveryClaim,
    ).toMatchObject({ phase: "prompt-dispatched", cancelled: true });

    useElicitationStore
      .getState()
      .completeDetachedDelivery("session-1", "question-1", token);
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toBeUndefined();
  });

  it("lets the user retry after a failed send", () => {
    void enqueue();
    useElicitationStore.getState().detachAll("session-1");
    const token = useElicitationStore
      .getState()
      .claimDetachedDelivery("session-1", "question-1") as symbol;

    useElicitationStore
      .getState()
      .failDetachedDelivery("session-1", "question-1", token);

    expect(
      useElicitationStore
        .getState()
        .claimDetachedDelivery("session-1", "question-1"),
    ).not.toBeNull();
  });

  it("settles live responders before forgetting an account's drafts", async () => {
    const response = enqueue();
    useElicitationStore
      .getState()
      .setValue("session-1", headId(), "notes", "private to this account");
    vi.runOnlyPendingTimers();
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toContain(
      "private to this account",
    );

    clearPersistedElicitations();

    await expect(response).resolves.toEqual({ action: "cancel" });

    // Session ids are not unique across accounts, so a draft that outlived one
    // could surface under another.
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toBeNull();
    expect(useElicitationStore.getState().pendingBySessionId).toEqual({});
  });

  it("drops persisted state it cannot parse instead of rereading it", () => {
    window.localStorage.setItem(ELICITATION_STORAGE_KEY, "{not json");
    useElicitationStore.setState({
      pendingBySessionId: loadPersistedForTests(),
    });
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toBeNull();
  });

  it("rejects a persistence envelope from another schema version", () => {
    window.localStorage.setItem(
      ELICITATION_STORAGE_KEY,
      JSON.stringify({ version: 1, scopes: [] }),
    );

    expect(loadPersistedForTests()).toEqual({});
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toBeNull();
  });

  it("rejects malformed persisted property schemas instead of casting them", () => {
    void enqueue();
    vi.runOnlyPendingTimers();
    const envelope = JSON.parse(
      window.localStorage.getItem(ELICITATION_STORAGE_KEY) ?? "{}",
    );
    envelope.scopes[0].queues[
      "session-1"
    ][0].request.requestedSchema.properties.notes = "not a property schema";
    window.localStorage.setItem(
      ELICITATION_STORAGE_KEY,
      JSON.stringify(envelope),
    );

    expect(loadPersistedForTests()).toEqual({});
    expect(window.localStorage.getItem(ELICITATION_STORAGE_KEY)).toBeNull();
  });

  it("reattaches a draft when the same question returns on a new connection", async () => {
    // The real transport always carries a wire id, and a reconnect always
    // brings a fresh one. If reattachment needed the id to be absent, an
    // ordinary reconnect would strand every draft.
    const legacy = {
      ...request,
      _meta: undefined,
    } as FormElicitationRequest;

    void new Promise<CreateElicitationResponse>((resolve) => {
      useElicitationStore.getState().enqueue({
        request: legacy,
        resolve,
        wireRequestId: 41,
        connectionIdentity: {
          providerId: "claude-acp",
          connectionGeneration: 1,
          connectionInstanceId: "conn-1",
        },
      });
    });
    const firstId = useElicitationStore.getState().pendingBySessionId[
      "session-1"
    ]?.[0]?.id as string;
    useElicitationStore
      .getState()
      .setValue("session-1", firstId, "notes", "typed before the drop");

    // The connection goes away; the draft survives detached.
    useElicitationStore.getState().detachAll("session-1");

    void new Promise<CreateElicitationResponse>((resolve) => {
      useElicitationStore.getState().enqueue({
        request: legacy,
        resolve,
        wireRequestId: 1,
        connectionIdentity: {
          providerId: "claude-acp",
          connectionGeneration: 2,
          connectionInstanceId: "conn-2",
        },
      });
    });

    const queue =
      useElicitationStore.getState().pendingBySessionId["session-1"] ?? [];
    expect(queue).toHaveLength(1);
    expect(queue[0]?.content.notes).toBe("typed before the drop");
    expect(queue[0]?.resolve).not.toBeNull();
  });

  it("keeps two ambiguous drafts separate rather than guessing", async () => {
    // Same shape, two detached drafts: reattaching either one would be a
    // coin flip, so a returning question becomes its own entry instead.
    const legacy = { ...request, _meta: undefined } as FormElicitationRequest;
    for (const [gen, wire] of [
      [1, 11],
      [1, 12],
    ] as const) {
      void new Promise<CreateElicitationResponse>((resolve) => {
        useElicitationStore.getState().enqueue({
          request: legacy,
          resolve,
          wireRequestId: wire,
          connectionIdentity: {
            providerId: "claude-acp",
            connectionGeneration: gen,
            connectionInstanceId: `conn-${gen}`,
          },
        });
      });
    }
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toHaveLength(2);
    useElicitationStore.getState().detachAll("session-1");

    void new Promise<CreateElicitationResponse>((resolve) => {
      useElicitationStore.getState().enqueue({
        request: legacy,
        resolve,
        wireRequestId: 21,
        connectionIdentity: {
          providerId: "claude-acp",
          connectionGeneration: 2,
          connectionInstanceId: "conn-2",
        },
      });
    });

    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"],
    ).toHaveLength(3);
  });
});
