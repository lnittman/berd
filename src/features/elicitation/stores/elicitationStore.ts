import { create } from "zustand";
import type {
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";

const ELICITATION_STORAGE_KEY = "berd:pending-elicitations:v1";

export type FormElicitationRequest = {
  sessionId: string;
  mode: "form";
  message: string;
  requestedSchema: ElicitationSchema;
  toolCallId?: string | null;
  _meta?: Record<string, unknown> | null;
};

export type ElicitationContinuation = "response" | "prompt";

export interface PendingElicitation {
  id: string;
  request: FormElicitationRequest;
  content: Record<string, ElicitationContentValue>;
  step: number;
  recovered: boolean;
  continuation: ElicitationContinuation;
  resolve: ((response: CreateElicitationResponse) => void) | null;
  responderKey: symbol | null;
}

interface ElicitationState {
  pendingBySessionId: Record<string, PendingElicitation[]>;
  enqueue: (pending: {
    request: FormElicitationRequest;
    resolve: (response: CreateElicitationResponse) => void;
  }) => symbol;
  setValue: (
    sessionId: string,
    key: string,
    value: ElicitationContentValue | undefined,
  ) => void;
  setStep: (sessionId: string, step: number) => void;
  accept: (sessionId: string) => void;
  decline: (sessionId: string) => void;
  cancel: (sessionId: string) => void;
  discardDetached: (sessionId: string, id: string) => boolean;
  abort: (sessionId: string, id: string, responderKey: symbol) => void;
  detachAll: (sessionId?: string) => void;
  cancelAll: (sessionId?: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stableLegacyId(request: FormElicitationRequest): string {
  const source = JSON.stringify([
    request.sessionId,
    request.message,
    request.requestedSchema,
  ]);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy:${request.sessionId}:${(hash >>> 0).toString(36)}`;
}

export function getElicitationMetadata(request: FormElicitationRequest): {
  id: string;
  recovered: boolean;
  continuation: ElicitationContinuation;
} {
  const goose = asRecord(asRecord(request._meta)?.goose);
  return {
    id:
      typeof goose?.elicitationId === "string"
        ? goose.elicitationId
        : typeof request.toolCallId === "string" &&
            request.toolCallId.length > 0
          ? `tool:${request.sessionId}:${request.toolCallId}`
          : stableLegacyId(request),
    recovered: goose?.recovered === true,
    continuation: goose?.continuation === "prompt" ? "prompt" : "response",
  };
}

export function getOtherCompanionParent(
  schema: ElicitationPropertySchema,
): string | null {
  const raw = schema as Record<string, unknown>;
  const meta = asRecord(raw._meta);
  const shared = asRecord(meta?._askUserQuestionCustomAnswer);
  if (
    shared?.isCustomAnswer === true &&
    typeof shared.questionId === "string" &&
    shared.questionId.length > 0
  ) {
    return shared.questionId;
  }
  const codex = asRecord(meta?.codex);
  return codex?.isOtherAnswer === true &&
    typeof codex.questionId === "string" &&
    codex.questionId.length > 0
    ? codex.questionId
    : null;
}

export function isSecretElicitationProperty(
  schema: ElicitationPropertySchema,
): boolean {
  const raw = schema as Record<string, unknown>;
  const codex = asRecord(asRecord(raw._meta)?.codex);
  return codex?.isSecret === true;
}

function isOtherCompanion(
  name: string,
  schema: ElicitationPropertySchema,
): boolean {
  const raw = schema as Record<string, unknown>;
  const meta = asRecord(raw._meta);
  const codex = asRecord(meta?.codex);
  const title = typeof raw.title === "string" ? raw.title.toLowerCase() : "";
  return (
    getOtherCompanionParent(schema) !== null ||
    codex?.isOtherAnswer === true ||
    ((name.endsWith("__other") || name.endsWith("_custom")) &&
      title === "other")
  );
}

export function findOtherCompanion(
  properties: Record<string, ElicitationPropertySchema>,
  fieldName: string,
): [string, ElicitationPropertySchema] | null {
  for (const [name, schema] of Object.entries(properties)) {
    if (getOtherCompanionParent(schema) === fieldName) {
      return [name, schema];
    }
  }
  for (const suffix of ["__other", "_custom"]) {
    const name = `${fieldName}${suffix}`;
    const schema = properties[name];
    if (schema && isOtherCompanion(name, schema)) return [name, schema];
  }
  return null;
}

export function isOtherCompanionField(
  properties: Record<string, ElicitationPropertySchema>,
  fieldName: string,
): boolean {
  const schema = properties[fieldName];
  if (!schema || !isOtherCompanion(fieldName, schema)) return false;
  const explicitParent = getOtherCompanionParent(schema);
  if (explicitParent) return explicitParent in properties;
  return ["__other", "_custom"].some((suffix) => {
    if (!fieldName.endsWith(suffix)) return false;
    return fieldName.slice(0, -suffix.length) in properties;
  });
}

function initialContent(
  request: FormElicitationRequest,
): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {};
  for (const [name, schema] of Object.entries(
    request.requestedSchema.properties ?? {},
  )) {
    if (isSecretElicitationProperty(schema)) continue;
    const value = (schema as Record<string, unknown>).default;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      (Array.isArray(value) && value.every((item) => typeof item === "string"))
    ) {
      content[name] = value as ElicitationContentValue;
    }
  }
  return content;
}

function normalizedContent(
  pending: PendingElicitation,
): Record<string, ElicitationContentValue> {
  const properties = pending.request.requestedSchema.properties ?? {};
  const content = Object.fromEntries(
    Object.entries(pending.content).filter(([, value]) => {
      if (typeof value === "string") return value.trim().length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }),
  ) as Record<string, ElicitationContentValue>;

  for (const fieldName of Object.keys(properties)) {
    const companion = findOtherCompanion(properties, fieldName);
    if (!companion) continue;
    const [companionName] = companion;
    const custom = content[companionName];
    if (typeof custom === "string" && custom.trim()) {
      delete content[fieldName];
      content[companionName] = custom.trim();
    } else {
      delete content[companionName];
    }
  }

  return content;
}

export function acceptedElicitationResponse(
  pending: PendingElicitation,
): CreateElicitationResponse {
  return { action: "accept", content: normalizedContent(pending) };
}

function removeFirst(
  queues: Record<string, PendingElicitation[]>,
  sessionId: string,
) {
  const next = { ...queues };
  const remaining = next[sessionId]?.slice(1) ?? [];
  if (remaining.length) next[sessionId] = remaining;
  else delete next[sessionId];
  return next;
}

function removeById(
  queues: Record<string, PendingElicitation[]>,
  sessionId: string,
  id: string,
) {
  const next = { ...queues };
  const remaining = (next[sessionId] ?? []).filter(
    (pending) => pending.id !== id,
  );
  if (remaining.length) next[sessionId] = remaining;
  else delete next[sessionId];
  return next;
}

function contentWithoutSecrets(
  request: FormElicitationRequest,
  content: Record<string, ElicitationContentValue>,
): Record<string, ElicitationContentValue> {
  const properties = request.requestedSchema.properties ?? {};
  return Object.fromEntries(
    Object.entries(content).filter(
      ([name]) =>
        !properties[name] || !isSecretElicitationProperty(properties[name]),
    ),
  );
}

function requestWithoutSecretDefaults(
  request: FormElicitationRequest,
): FormElicitationRequest {
  const properties = request.requestedSchema.properties ?? {};
  const sanitizedProperties = Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      if (!isSecretElicitationProperty(schema)) return [name, schema];
      const { default: _default, ...sanitized } = schema as Record<
        string,
        unknown
      >;
      return [name, sanitized as ElicitationPropertySchema];
    }),
  );
  return {
    ...request,
    requestedSchema: {
      ...request.requestedSchema,
      properties: sanitizedProperties,
    },
  };
}

function loadPersisted(): Record<string, PendingElicitation[]> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
    if (!raw) return {};
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return {};

    const queues: Record<string, PendingElicitation[]> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const queue = value.flatMap((candidate) => {
        const item = asRecord(candidate);
        const request = asRecord(item?.request);
        if (
          !item ||
          typeof item.id !== "string" ||
          request?.mode !== "form" ||
          request.sessionId !== sessionId ||
          !asRecord(request.requestedSchema)
        ) {
          return [];
        }
        const loadedRequest = request as FormElicitationRequest;
        return [
          {
            id: item.id,
            request: loadedRequest,
            content: contentWithoutSecrets(
              loadedRequest,
              (asRecord(item.content) ?? {}) as Record<
                string,
                ElicitationContentValue
              >,
            ),
            step:
              typeof item.step === "number" && Number.isFinite(item.step)
                ? Math.max(0, Math.floor(item.step))
                : 0,
            recovered: item.recovered === true,
            continuation:
              item.continuation === "prompt" ? "prompt" : "response",
            resolve: null,
            responderKey: null,
          } satisfies PendingElicitation,
        ];
      });
      if (queue.length) queues[sessionId] = queue;
    }
    return queues;
  } catch {
    return {};
  }
}

function persist(queues: Record<string, PendingElicitation[]>): void {
  if (typeof window === "undefined") return;
  try {
    const serializable = Object.fromEntries(
      Object.entries(queues).map(([sessionId, queue]) => [
        sessionId,
        queue.map(
          ({ resolve: _resolve, responderKey: _responderKey, ...pending }) => ({
            ...pending,
            request: requestWithoutSecretDefaults(pending.request),
            content: contentWithoutSecrets(pending.request, pending.content),
          }),
        ),
      ]),
    );
    window.localStorage.setItem(
      ELICITATION_STORAGE_KEY,
      JSON.stringify(serializable),
    );
  } catch {
    // Persistence is best-effort; the live responder remains authoritative.
  }
}

export const useElicitationStore = create<ElicitationState>((set, get) => ({
  pendingBySessionId: loadPersisted(),
  enqueue: ({ request, resolve }) => {
    const responderKey = Symbol("elicitation-responder");
    set((state) => {
      const metadata = getElicitationMetadata(request);
      const queue = state.pendingBySessionId[request.sessionId] ?? [];
      const existingIndex = queue.findIndex(
        (pending) => pending.id === metadata.id,
      );
      const pending: PendingElicitation =
        existingIndex >= 0
          ? {
              ...queue[existingIndex],
              request,
              recovered: metadata.recovered,
              continuation: metadata.continuation,
              resolve: queue[existingIndex].resolve
                ? (response) => {
                    queue[existingIndex].resolve?.(response);
                    resolve(response);
                  }
                : resolve,
              responderKey,
            }
          : {
              id: metadata.id,
              request,
              content: initialContent(request),
              step: 0,
              recovered: metadata.recovered,
              continuation: metadata.continuation,
              resolve,
              responderKey,
            };
      const nextQueue = [...queue];
      if (existingIndex >= 0) nextQueue[existingIndex] = pending;
      else nextQueue.push(pending);
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [request.sessionId]: nextQueue,
        },
      };
    });
    return responderKey;
  },
  setValue: (sessionId, key, value) =>
    set((state) => {
      const queue = state.pendingBySessionId[sessionId];
      if (!queue?.[0]) return state;
      const content = { ...queue[0].content };
      if (value === undefined) delete content[key];
      else content[key] = value;
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: [{ ...queue[0], content }, ...queue.slice(1)],
        },
      };
    }),
  setStep: (sessionId, step) =>
    set((state) => {
      const queue = state.pendingBySessionId[sessionId];
      if (!queue?.[0]) return state;
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: [
            { ...queue[0], step: Math.max(0, step) },
            ...queue.slice(1),
          ],
        },
      };
    }),
  accept: (sessionId) => {
    const pending = get().pendingBySessionId[sessionId]?.[0];
    if (!pending?.resolve) return;
    set((state) => ({
      pendingBySessionId: removeFirst(state.pendingBySessionId, sessionId),
    }));
    pending.resolve(acceptedElicitationResponse(pending));
  },
  decline: (sessionId) => {
    const pending = get().pendingBySessionId[sessionId]?.[0];
    if (!pending?.resolve) return;
    set((state) => ({
      pendingBySessionId: removeFirst(state.pendingBySessionId, sessionId),
    }));
    pending.resolve({ action: "decline" });
  },
  cancel: (sessionId) => {
    const pending = get().pendingBySessionId[sessionId]?.[0];
    if (!pending) return;
    set((state) => ({
      pendingBySessionId: removeFirst(state.pendingBySessionId, sessionId),
    }));
    pending.resolve?.({ action: "cancel" });
  },
  discardDetached: (sessionId, id) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!pending || pending.resolve !== null) return false;
    set((state) => ({
      pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
    }));
    return true;
  },
  abort: (sessionId, id, responderKey) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!pending || pending.responderKey !== responderKey) return;
    set((state) => ({
      pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
    }));
    pending.resolve?.({ action: "cancel" });
  },
  detachAll: (sessionId) =>
    set((state) => {
      const pendingBySessionId = Object.fromEntries(
        Object.entries(state.pendingBySessionId).map(([id, queue]) => [
          id,
          !sessionId || id === sessionId
            ? queue.map((pending) => ({
                ...pending,
                resolve: null,
                responderKey: null,
              }))
            : queue,
        ]),
      );
      return { pendingBySessionId };
    }),
  cancelAll: (sessionId) => {
    const queues = get().pendingBySessionId;
    const targets = sessionId
      ? { [sessionId]: queues[sessionId] ?? [] }
      : queues;
    set((state) => {
      if (!sessionId) return { pendingBySessionId: {} };
      const next = { ...state.pendingBySessionId };
      delete next[sessionId];
      return { pendingBySessionId: next };
    });
    for (const pending of Object.values(targets).flat()) {
      pending.resolve?.({ action: "cancel" });
    }
  },
}));

useElicitationStore.subscribe((state) => persist(state.pendingBySessionId));
