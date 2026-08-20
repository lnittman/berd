import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type {
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";
import {
  encodedByteLength,
  MAX_PERSISTED_ELICITATION_BYTES,
} from "@/features/elicitation/lib/elicitationSchemaLimits";
import {
  elicitationFieldKind,
  isSecretElicitationProperty,
} from "@/features/elicitation/lib/elicitationFieldKind";
import {
  ELICITATION_PERSISTENCE_VERSION,
  ELICITATION_STORAGE_KEY,
  type ElicitationPersistenceIdentityInput,
  type ElicitationPersistenceScope,
  LEGACY_ELICITATION_STORAGE_KEYS,
  type NativeElicitationPersistenceEnvelope,
  nativeElicitationPersistenceEnvelopeSchema,
  persistedElicitationSchema,
  persistedElicitationEnvelopeSchema,
  type PersistedElicitationSessionRecord,
  persistenceRecordKey,
  persistenceScopeKey,
  sharesPersistenceNamespace,
} from "@/features/elicitation/lib/elicitationPersistence";

const ELICITATION_PERSIST_DELAY_MS = 100;
const ELICITATION_MAX_PERSISTED_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let persistenceTimer: number | null = null;
let nativePersistenceEnvelope: NativeElicitationPersistenceEnvelope | null =
  null;
let nativeWriteChain = Promise.resolve();

export { ELICITATION_STORAGE_KEY } from "@/features/elicitation/lib/elicitationPersistence";

let persistenceIdentity: ElicitationPersistenceIdentityInput | null = null;
const hydratedPersistenceScopes = new Set<string>();

function identityFingerprint(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

export function configureElicitationPersistenceIdentity(
  identity: ElicitationPersistenceIdentityInput,
): void {
  const next = {
    accountId: `account:sha256:${identityFingerprint(identity.accountId.trim())}`,
    workspaceId: `workspace:sha256:${identityFingerprint(identity.workspaceId.trim())}`,
  };
  if (
    persistenceIdentity?.accountId === next.accountId &&
    persistenceIdentity.workspaceId === next.workspaceId
  ) {
    return;
  }
  persistenceIdentity = next;
  hydratedPersistenceScopes.clear();
}

function usesNativePersistence(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

/** Establish the exact identity and load the app-global native persistence
 * snapshot before an ACP runtime can receive a request. */
export async function prepareElicitationPersistenceIdentity(
  identity: ElicitationPersistenceIdentityInput,
): Promise<void> {
  configureElicitationPersistenceIdentity(identity);
  if (!usesNativePersistence()) return;
  await nativeWriteChain;
  try {
    const serialized = await invoke<string | null>(
      "load_elicitation_persistence",
    );
    if (
      !serialized ||
      encodedByteLength(serialized) > MAX_PERSISTED_ELICITATION_BYTES
    ) {
      nativePersistenceEnvelope = null;
      return;
    }
    const parsed = nativeElicitationPersistenceEnvelopeSchema.safeParse(
      JSON.parse(serialized),
    );
    nativePersistenceEnvelope = parsed.success ? parsed.data : null;
  } catch {
    // Failing closed keeps a renderer-local cache from becoming authoritative
    // when the app-global persistence owner is unavailable.
    nativePersistenceEnvelope = null;
  }
}

export function getElicitationPersistenceScope(
  providerId: string,
  connectionGeneration: number,
  connectionInstanceId = `test-connection:${Math.max(0, Math.floor(connectionGeneration))}`,
): ElicitationPersistenceScope | null {
  if (!persistenceIdentity) return null;
  return {
    ...persistenceIdentity,
    providerId: providerId.trim() || "unknown",
    connectionGeneration: Math.max(0, Math.floor(connectionGeneration)),
    connectionInstanceId: connectionInstanceId.trim() || "unknown",
  };
}

function scopesCanReplay(
  existing: ElicitationPersistenceScope | null,
  incoming: ElicitationPersistenceScope | null,
): boolean {
  if (!existing || !incoming) return true;
  return sharesPersistenceNamespace(existing, incoming);
}

export type FormElicitationRequest = {
  sessionId: string;
  mode: "form";
  message: string;
  requestedSchema: ElicitationSchema;
  toolCallId?: string | null;
  _meta?: Record<string, unknown> | null;
};

export type ElicitationContinuation = "response" | "prompt";

export interface ElicitationConnectionIdentity {
  providerId: string;
  connectionGeneration: number;
  connectionInstanceId: string;
}

interface DetachedDeliveryClaim {
  token: symbol;
  phase: "claiming" | "prompt-dispatched" | "indeterminate";
  cancelled: boolean;
}

export interface PendingElicitation {
  id: string;
  /** Stable across reconnects; never includes the JSON-RPC request id. */
  semanticKey: string;
  /** Identifies the live responder, not the persisted question. */
  wireRequestId: string | number | null;
  request: FormElicitationRequest;
  content: Record<string, ElicitationContentValue>;
  step: number;
  recovered: boolean;
  continuation: ElicitationContinuation;
  resolve: ((response: CreateElicitationResponse) => void) | null;
  responderKey: symbol | null;
  /** Held while this question's answers are in flight as an ordinary message. */
  deliveryClaim: DetachedDeliveryClaim | null;
  /** Identity boundary used for persistence; null drafts remain memory-only. */
  persistenceScope: ElicitationPersistenceScope | null;
  /** When this question was first seen, for expiry. Never refreshed by a write. */
  savedAt: number;
}

interface ElicitationState {
  pendingBySessionId: Record<string, PendingElicitation[]>;
  enqueue: (pending: {
    request: FormElicitationRequest;
    resolve: (response: CreateElicitationResponse) => void;
    wireRequestId?: string | number;
    persistenceScope?: ElicitationPersistenceScope | null;
    connectionIdentity?: ElicitationConnectionIdentity;
  }) => { id: string; responderKey: symbol };
  setValue: (
    sessionId: string,
    id: string,
    key: string,
    value: ElicitationContentValue | undefined,
  ) => void;
  setStep: (sessionId: string, id: string, step: number) => void;
  accept: (sessionId: string, id: string) => void;
  decline: (sessionId: string, id: string) => void;
  cancel: (sessionId: string, id: string) => void;
  retainUndeliveredAnswers: (
    request: FormElicitationRequest,
    content: Record<string, ElicitationContentValue>,
    persistenceScope?: ElicitationPersistenceScope | null,
    connectionIdentity?: ElicitationConnectionIdentity,
  ) => void;
  claimDetachedDelivery: (sessionId: string, id: string) => symbol | null;
  beginDetachedDelivery: (
    sessionId: string,
    id: string,
    token: symbol,
  ) => boolean;
  completeDetachedDelivery: (
    sessionId: string,
    id: string,
    token: symbol,
  ) => void;
  failDetachedDelivery: (
    sessionId: string,
    id: string,
    token: symbol,
  ) => "retryable" | "indeterminate" | "ignored";
  abort: (sessionId: string, id: string, responderKey: symbol) => void;
  detachAll: (sessionId?: string) => void;
  cancelAll: (sessionId?: string) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function schemaWithoutDefaults(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schemaWithoutDefaults);
  const record = asRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record).flatMap(([key, nested]) =>
      key === "default" ? [] : [[key, schemaWithoutDefaults(nested)]],
    ),
  );
}

function stableDigest(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}

function stableLegacyId(
  request: FormElicitationRequest,
  providerId: string,
): string {
  // Older ACP clients provide no stable request identity. Hash the complete
  // semantic shape with a collision-resistant digest; defaults are excluded so
  // secret-default sanitation cannot change identity during persistence.
  return `legacy:${stableDigest([
    providerId,
    request.sessionId,
    request.toolCallId ?? null,
    request.message,
    schemaWithoutDefaults(request.requestedSchema),
  ])}`;
}

export function getElicitationMetadata(
  request: FormElicitationRequest,
  /**
   * JSON-RPC id of the live request, when there is one. Two identical questions
   * asked at once hash the same, so without this they would share one entry and
   * a single answer would resolve both.
   */
  wireRequestId?: string | number,
  connectionIdentity: ElicitationConnectionIdentity = {
    providerId: "unknown",
    connectionGeneration: 0,
    connectionInstanceId: "unknown",
  },
): {
  id: string;
  semanticKey: string;
  wireRequestId: string | number | null;
  recovered: boolean;
  continuation: ElicitationContinuation;
} {
  const goose = asRecord(asRecord(request._meta)?.goose);
  const recovered = goose?.recovered === true;
  const elicitationId =
    typeof goose?.elicitationId === "string" && goose.elicitationId.length > 0
      ? goose.elicitationId
      : null;
  const semanticKey = elicitationId
    ? `goose:${stableDigest([
        connectionIdentity.providerId,
        request.sessionId,
        elicitationId,
      ])}`
    : stableLegacyId(request, connectionIdentity.providerId);
  const wireId = wireRequestId ?? null;
  return {
    id:
      wireId !== null
        ? `wire:${stableDigest([
            connectionIdentity.providerId,
            Math.max(0, Math.floor(connectionIdentity.connectionGeneration)),
            connectionIdentity.connectionInstanceId,
            request.sessionId,
            typeof wireId,
            String(wireId),
          ])}`
        : (elicitationId ?? semanticKey),
    semanticKey,
    wireRequestId: wireId,
    recovered,
    // Continuing as a prompt is a recovery behaviour. Honouring it on a request
    // that is not marked recovered would let arbitrary metadata redirect a live
    // question into an ordinary message.
    continuation:
      recovered && goose?.continuation === "prompt" ? "prompt" : "response",
  };
}

function uniquePendingId(
  queue: PendingElicitation[],
  preferred: string,
): string {
  if (!queue.some((pending) => pending.id === preferred)) return preferred;
  let suffix = 2;
  while (queue.some((pending) => pending.id === `${preferred}:${suffix}`)) {
    suffix += 1;
  }
  return `${preferred}:${suffix}`;
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

function otherCompanionParentName(
  properties: Record<string, ElicitationPropertySchema>,
  name: string,
  schema: ElicitationPropertySchema,
): string | null {
  const explicitParent = getOtherCompanionParent(schema);
  if (explicitParent) return explicitParent;
  if (!isOtherCompanion(name, schema)) return null;
  for (const suffix of ["__other", "_custom"]) {
    if (name.endsWith(suffix)) {
      const parentName = name.slice(0, -suffix.length);
      return parentName in properties ? parentName : null;
    }
  }
  return null;
}

function hasUnsupportedCompanionParent(
  properties: Record<string, ElicitationPropertySchema>,
  name: string,
  schema: ElicitationPropertySchema,
): boolean {
  const parentName = otherCompanionParentName(properties, name, schema);
  const parent = parentName ? properties[parentName] : undefined;
  return Boolean(parent && elicitationFieldKind(parent) === "unsupported");
}

export function findOtherCompanion(
  properties: Record<string, ElicitationPropertySchema>,
  fieldName: string,
): [string, ElicitationPropertySchema] | null {
  const parent = properties[fieldName];
  if (!parent || elicitationFieldKind(parent) === "unsupported") return null;
  for (const [name, schema] of Object.entries(properties)) {
    if (
      elicitationFieldKind(schema) !== "unsupported" &&
      getOtherCompanionParent(schema) === fieldName
    ) {
      return [name, schema];
    }
  }
  for (const suffix of ["__other", "_custom"]) {
    const name = `${fieldName}${suffix}`;
    const schema = properties[name];
    if (
      schema &&
      elicitationFieldKind(schema) !== "unsupported" &&
      isOtherCompanion(name, schema)
    ) {
      return [name, schema];
    }
  }
  return null;
}

export function isOtherCompanionField(
  properties: Record<string, ElicitationPropertySchema>,
  fieldName: string,
): boolean {
  const schema = properties[fieldName];
  if (
    !schema ||
    elicitationFieldKind(schema) === "unsupported" ||
    !isOtherCompanion(fieldName, schema)
  ) {
    return false;
  }
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
  // Provider defaults are not guaranteed to satisfy the schema they ship with,
  // so they go through the same filter restored content gets rather than being
  // trusted verbatim: an out-of-enum default would otherwise read as answered
  // and then be dropped from the accepted payload.
  return contentForRequest(request, content, false);
}

function allowedStringValues(
  schema: Record<string, unknown>,
  optionsKey: "oneOf" | "anyOf",
): Set<string> | null {
  if (Array.isArray(schema.enum)) {
    return new Set(
      schema.enum.filter((value): value is string => typeof value === "string"),
    );
  }
  const options = schema[optionsKey];
  if (!Array.isArray(options)) return null;
  return new Set(
    options.flatMap((option) => {
      const raw = asRecord(option);
      return typeof raw?.const === "string" ? [raw.const] : [];
    }),
  );
}

function contentForRequest(
  request: FormElicitationRequest,
  content: Record<string, ElicitationContentValue>,
  includeSecrets: boolean,
): Record<string, ElicitationContentValue> {
  const properties = request.requestedSchema.properties ?? {};
  const next: Record<string, ElicitationContentValue> = {};
  for (const [name, value] of Object.entries(content)) {
    const schema = properties[name];
    if (!schema || (!includeSecrets && isSecretElicitationProperty(schema))) {
      continue;
    }
    if (elicitationFieldKind(schema) === "unsupported") continue;
    if (hasUnsupportedCompanionParent(properties, name, schema)) continue;

    const raw = schema as Record<string, unknown>;
    if (schema.type === "string") {
      if (typeof value !== "string") continue;
      const allowed = allowedStringValues(raw, "oneOf");
      if (!allowed || allowed.has(value)) next[name] = value;
      continue;
    }
    if (schema.type === "number") {
      if (typeof value === "number" && Number.isFinite(value)) {
        next[name] = value;
      }
      continue;
    }
    if (schema.type === "integer") {
      if (typeof value === "number" && Number.isInteger(value)) {
        next[name] = value;
      }
      continue;
    }
    if (schema.type === "boolean") {
      if (typeof value === "boolean") next[name] = value;
      continue;
    }
    if (schema.type === "array") {
      if (!Array.isArray(value)) continue;
      const items = asRecord(raw.items);
      const allowed = items ? allowedStringValues(items, "anyOf") : null;
      const selected = allowed
        ? value.filter((item) => allowed.has(item))
        : value;
      if (value.length === 0 || selected.length > 0) next[name] = selected;
    }
  }
  return next;
}

function normalizedContent(
  pending: PendingElicitation,
): Record<string, ElicitationContentValue> {
  const properties = pending.request.requestedSchema.properties ?? {};
  const content = Object.fromEntries(
    Object.entries(
      contentForRequest(pending.request, pending.content, true),
    ).filter(([, value]) => {
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
      if (properties[fieldName]?.type !== "array") {
        delete content[fieldName];
      }
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

/** The question a session should be showing. A live request always wins over a
 * recovered draft: nothing is waiting on the draft, and letting it sit in front
 * would hide a request the agent is actually blocked on. */
export function presentedElicitation(
  queue: PendingElicitation[] | undefined,
): PendingElicitation | null {
  if (!queue?.length) return null;
  return queue.find((pending) => pending.resolve !== null) ?? queue[0];
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
  return contentForRequest(request, content, false);
}

function requestWithoutSecretDefaults(
  request: FormElicitationRequest,
): FormElicitationRequest {
  const properties = request.requestedSchema.properties ?? {};
  const sanitizedProperties = Object.fromEntries(
    Object.entries(properties).map(([name, schema]) => {
      if (
        !isSecretElicitationProperty(schema) &&
        !hasUnsupportedCompanionParent(properties, name, schema)
      ) {
        return [name, schema];
      }
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

function recordsFromBrowserEnvelope(
  envelope: ReturnType<typeof persistedElicitationEnvelopeSchema.parse> | null,
): Record<string, PersistedElicitationSessionRecord> {
  if (!envelope) return {};
  return Object.fromEntries(
    envelope.scopes.flatMap((stored) =>
      Object.entries(stored.queues).map(([sessionId, queue]) => [
        persistenceRecordKey(stored.identity, sessionId),
        { identity: stored.identity, sessionId, queue },
      ]),
    ),
  );
}

function browserEnvelopeFromRecords(
  records: Record<string, PersistedElicitationSessionRecord>,
): ReturnType<typeof persistedElicitationEnvelopeSchema.parse> {
  const scopes = new Map<
    string,
    {
      identity: ElicitationPersistenceScope;
      queues: Record<string, PersistedElicitationSessionRecord["queue"]>;
    }
  >();
  for (const record of Object.values(records)) {
    const key = persistenceScopeKey(record.identity);
    const stored = scopes.get(key) ?? { identity: record.identity, queues: {} };
    stored.queues[record.sessionId] = record.queue;
    scopes.set(key, stored);
  }
  return {
    version: ELICITATION_PERSISTENCE_VERSION,
    scopes: [...scopes.values()],
  };
}

function readPersistedEnvelope(): ReturnType<
  typeof persistedElicitationEnvelopeSchema.parse
> | null {
  if (typeof window === "undefined") return null;
  if (usesNativePersistence()) {
    return nativePersistenceEnvelope
      ? browserEnvelopeFromRecords(nativePersistenceEnvelope.records)
      : null;
  }
  try {
    for (const key of LEGACY_ELICITATION_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    const raw = window.localStorage.getItem(ELICITATION_STORAGE_KEY);
    if (!raw) return null;
    if (encodedByteLength(raw) > MAX_PERSISTED_ELICITATION_BYTES) {
      window.localStorage.removeItem(ELICITATION_STORAGE_KEY);
      return null;
    }
    const parsed = persistedElicitationEnvelopeSchema.safeParse(
      JSON.parse(raw),
    );
    if (parsed.success) return parsed.data;
    window.localStorage.removeItem(ELICITATION_STORAGE_KEY);
    return null;
  } catch {
    // Storage that cannot be parsed will not repair itself on the next launch.
    try {
      window.localStorage.removeItem(ELICITATION_STORAGE_KEY);
    } catch {
      // Nothing more to do if storage itself is unavailable.
    }
    return null;
  }
}

function latestSavedAt(
  queues: Record<string, Array<{ savedAt: number }>>,
): number {
  return Math.max(
    0,
    ...Object.values(queues)
      .flat()
      .map((pending) => pending.savedAt),
  );
}

function sameScopedPending(
  left: Pick<PendingElicitation, "id" | "persistenceScope">,
  right: Pick<PendingElicitation, "id" | "persistenceScope">,
): boolean {
  if (left.id !== right.id) return false;
  if (!left.persistenceScope || !right.persistenceScope) {
    return left.persistenceScope === right.persistenceScope;
  }
  return (
    persistenceScopeKey(left.persistenceScope) ===
    persistenceScopeKey(right.persistenceScope)
  );
}

function loadPersisted(
  scope: ElicitationPersistenceScope | null,
): Record<string, PendingElicitation[]> {
  if (!scope) return {};
  const envelope = readPersistedEnvelope();
  if (!envelope) return {};

  const matchingScopes = envelope.scopes
    .filter((stored) => sharesPersistenceNamespace(stored.identity, scope))
    .sort((left, right) => {
      const leftExact =
        persistenceScopeKey(left.identity) === persistenceScopeKey(scope);
      const rightExact =
        persistenceScopeKey(right.identity) === persistenceScopeKey(scope);
      if (leftExact !== rightExact) return leftExact ? -1 : 1;
      return latestSavedAt(right.queues) - latestSavedAt(left.queues);
    });
  for (const stored of matchingScopes) {
    hydratedPersistenceScopes.add(persistenceScopeKey(stored.identity));
  }
  const queues: Record<string, PendingElicitation[]> = {};
  const oldestAllowed = Date.now() - ELICITATION_MAX_PERSISTED_AGE_MS;
  for (const stored of matchingScopes) {
    for (const [sessionId, persistedQueue] of Object.entries(stored.queues)) {
      const queue = queues[sessionId] ?? [];
      for (const item of persistedQueue) {
        if (
          item.request.sessionId !== sessionId ||
          item.savedAt < oldestAllowed ||
          queue.some((pending) =>
            sameScopedPending(pending, {
              id: item.id,
              persistenceScope: stored.identity,
            }),
          )
        ) {
          continue;
        }
        const loadedRequest = item.request as unknown as FormElicitationRequest;
        queue.push({
          id: item.id,
          semanticKey: item.semanticKey,
          wireRequestId: item.wireRequestId,
          request: loadedRequest,
          content: contentWithoutSecrets(
            loadedRequest,
            item.content as Record<string, ElicitationContentValue>,
          ),
          step: item.step,
          recovered: item.recovered,
          continuation: item.continuation,
          resolve: null,
          responderKey: null,
          deliveryClaim: null,
          persistenceScope: stored.identity,
          savedAt: item.savedAt,
        });
      }
      if (queue.length) queues[sessionId] = queue;
    }
  }
  return queues;
}

/** Test only: production hydration occurs when a scoped request first arrives. */
export function loadPersistedForTests(
  scope = getElicitationPersistenceScope("unknown", 0),
): Record<string, PendingElicitation[]> {
  return loadPersisted(scope);
}

interface PersistenceDescriptor {
  scope: ElicitationPersistenceScope;
  sessionId: string;
}

function collectPersistenceDescriptors(
  queues: Record<string, PendingElicitation[]>,
): Map<string, PersistenceDescriptor> {
  const descriptors = new Map<string, PersistenceDescriptor>();
  for (const [sessionId, queue] of Object.entries(queues)) {
    for (const pending of queue) {
      if (!pending.persistenceScope) continue;
      descriptors.set(
        persistenceRecordKey(pending.persistenceScope, sessionId),
        { scope: pending.persistenceScope, sessionId },
      );
    }
  }
  return descriptors;
}

function buildPersistedRecord(
  queues: Record<string, PendingElicitation[]>,
  descriptor: PersistenceDescriptor,
): PersistedElicitationSessionRecord | null {
  const expectedScopeKey = persistenceScopeKey(descriptor.scope);
  const queue = (queues[descriptor.sessionId] ?? []).flatMap((pending) => {
    if (
      pending.deliveryClaim ||
      !pending.persistenceScope ||
      persistenceScopeKey(pending.persistenceScope) !== expectedScopeKey
    ) {
      return [];
    }
    const parsed = persistedElicitationSchema.safeParse({
      id: pending.id,
      semanticKey: pending.semanticKey,
      wireRequestId: pending.wireRequestId,
      request: requestWithoutSecretDefaults(pending.request),
      content: contentWithoutSecrets(pending.request, pending.content),
      step: pending.step,
      recovered: pending.recovered,
      continuation: pending.continuation,
      savedAt: pending.savedAt,
    });
    return parsed.success ? [parsed.data] : [];
  });
  return queue.length
    ? { identity: descriptor.scope, sessionId: descriptor.sessionId, queue }
    : null;
}

function applyPersistenceUpdates(
  records: Record<string, PersistedElicitationSessionRecord>,
  updates: Record<string, PersistedElicitationSessionRecord | null>,
): Record<string, PersistedElicitationSessionRecord> {
  const next = { ...records };
  for (const [key, record] of Object.entries(updates)) {
    if (record) next[key] = record;
    else delete next[key];
  }
  return next;
}

function persist(
  queues: Record<string, PendingElicitation[]>,
  descriptors: Map<string, PersistenceDescriptor>,
): void {
  if (typeof window === "undefined") return;
  try {
    const updates = Object.fromEntries(
      [...descriptors.entries()].map(([key, descriptor]) => [
        key,
        buildPersistedRecord(queues, descriptor),
      ]),
    ) as Record<string, PersistedElicitationSessionRecord | null>;
    if (!Object.keys(updates).length) return;

    if (usesNativePersistence()) {
      const serializedUpdates = JSON.stringify(updates);
      if (
        encodedByteLength(serializedUpdates) > MAX_PERSISTED_ELICITATION_BYTES
      ) {
        return;
      }
      nativeWriteChain = nativeWriteChain
        .then(async () => {
          await invoke("persist_elicitation_updates", { serializedUpdates });
          const records = applyPersistenceUpdates(
            nativePersistenceEnvelope?.records ?? {},
            updates,
          );
          nativePersistenceEnvelope = Object.keys(records).length
            ? { version: ELICITATION_PERSISTENCE_VERSION, records }
            : null;
        })
        .catch(() => {
          // Best effort; the live responder remains authoritative.
        });
      return;
    }

    for (const key of LEGACY_ELICITATION_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
    const records = applyPersistenceUpdates(
      recordsFromBrowserEnvelope(readPersistedEnvelope()),
      updates,
    );
    if (Object.keys(records).length === 0) {
      window.localStorage.removeItem(ELICITATION_STORAGE_KEY);
      return;
    }
    const serialized = JSON.stringify(browserEnvelopeFromRecords(records));
    if (encodedByteLength(serialized) > MAX_PERSISTED_ELICITATION_BYTES) {
      window.localStorage.removeItem(ELICITATION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(ELICITATION_STORAGE_KEY, serialized);
  } catch {
    // Persistence is best-effort; the live responder remains authoritative.
  }
}

let pendingPersistQueues: Record<string, PendingElicitation[]> | null = null;
let pendingPersistDescriptors = new Map<string, PersistenceDescriptor>();

function schedulePersist(
  queues: Record<string, PendingElicitation[]>,
  previousQueues: Record<string, PendingElicitation[]>,
): void {
  if (typeof window === "undefined") return;
  pendingPersistQueues = queues;
  for (const [key, descriptor] of [
    ...collectPersistenceDescriptors(previousQueues),
    ...collectPersistenceDescriptors(queues),
  ]) {
    pendingPersistDescriptors.set(key, descriptor);
  }
  if (persistenceTimer !== null) window.clearTimeout(persistenceTimer);
  persistenceTimer = window.setTimeout(() => {
    persistenceTimer = null;
    pendingPersistQueues = null;
    const descriptors = pendingPersistDescriptors;
    pendingPersistDescriptors = new Map();
    persist(queues, descriptors);
  }, ELICITATION_PERSIST_DELAY_MS);
}

/** Write any debounced draft immediately. The debounce is reset on every
 * keystroke, so without this a fast typist loses everything since the last
 * idle gap when the window goes away. */
export function flushElicitationDrafts(): void {
  if (typeof window === "undefined" || persistenceTimer === null) return;
  window.clearTimeout(persistenceTimer);
  persistenceTimer = null;
  const queues = pendingPersistQueues;
  const descriptors = pendingPersistDescriptors;
  pendingPersistQueues = null;
  pendingPersistDescriptors = new Map();
  if (queues) persist(queues, descriptors);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushElicitationDrafts);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushElicitationDrafts();
  });
}

export const useElicitationStore = create<ElicitationState>((set, get) => ({
  pendingBySessionId: {},
  enqueue: ({
    request,
    resolve,
    wireRequestId,
    persistenceScope,
    connectionIdentity,
  }) => {
    const responderKey = Symbol("elicitation-responder");
    const resolvedPersistenceScope =
      persistenceScope ?? getElicitationPersistenceScope("unknown", 0);
    const resolvedConnectionIdentity = connectionIdentity ?? {
      providerId: resolvedPersistenceScope?.providerId ?? "unknown",
      connectionGeneration: resolvedPersistenceScope?.connectionGeneration ?? 0,
      connectionInstanceId:
        resolvedPersistenceScope?.connectionInstanceId ?? "unknown",
    };
    const metadata = getElicitationMetadata(
      request,
      wireRequestId,
      resolvedConnectionIdentity,
    );
    if (resolvedPersistenceScope) {
      const scopeKey = persistenceScopeKey(resolvedPersistenceScope);
      if (!hydratedPersistenceScopes.has(scopeKey)) {
        hydratedPersistenceScopes.add(scopeKey);
        const hydrated = loadPersisted(resolvedPersistenceScope);
        set((state) => {
          const next = { ...state.pendingBySessionId };
          for (const [sessionId, persistedQueue] of Object.entries(hydrated)) {
            const queue = [...(next[sessionId] ?? [])];
            for (const pending of persistedQueue) {
              if (
                !queue.some((candidate) =>
                  sameScopedPending(candidate, pending),
                )
              ) {
                queue.push(pending);
              }
            }
            if (queue.length) next[sessionId] = queue;
          }
          return { pendingBySessionId: next };
        });
      }
    }
    let attachedId = metadata.id;
    let promptAlreadyOwnsResponse = false;
    set((state) => {
      const queue = state.pendingBySessionId[request.sessionId] ?? [];
      const exactIndex = queue.findIndex(
        (pending) =>
          pending.id === metadata.id &&
          pending.semanticKey === metadata.semanticKey &&
          scopesCanReplay(pending.persistenceScope, resolvedPersistenceScope),
      );
      // A reconnect always brings a fresh wire id, so the exact match misses and
      // the question is found by what it *is* rather than which request carried
      // it. Only a detached entry is eligible, and only when exactly one
      // matches, so an ambiguous pair stays visible instead of being merged.
      const detachedSemanticMatches = queue.flatMap((pending, index) =>
        pending.resolve === null &&
        pending.semanticKey === metadata.semanticKey &&
        scopesCanReplay(pending.persistenceScope, resolvedPersistenceScope)
          ? [index]
          : [],
      );
      const existingIndex =
        exactIndex >= 0
          ? exactIndex
          : detachedSemanticMatches.length === 1
            ? detachedSemanticMatches[0]
            : -1;
      attachedId =
        existingIndex >= 0
          ? queue[existingIndex].id
          : uniquePendingId(queue, metadata.id);
      const existingClaim =
        existingIndex >= 0 ? queue[existingIndex].deliveryClaim : null;
      if (
        existingClaim?.phase === "prompt-dispatched" ||
        existingClaim?.phase === "indeterminate"
      ) {
        promptAlreadyOwnsResponse = true;
        return state;
      }
      const pending: PendingElicitation =
        existingIndex >= 0
          ? {
              ...queue[existingIndex],
              request,
              content: {
                ...initialContent(request),
                ...contentWithoutSecrets(
                  request,
                  contentWithoutSecrets(
                    queue[existingIndex].request,
                    queue[existingIndex].content,
                  ),
                ),
              },
              recovered: metadata.recovered,
              continuation: metadata.continuation,
              wireRequestId: metadata.wireRequestId,
              persistenceScope: resolvedPersistenceScope,
              resolve: queue[existingIndex].resolve
                ? (response) => {
                    queue[existingIndex].resolve?.(response);
                    resolve(response);
                  }
                : resolve,
              responderKey,
            }
          : {
              id: attachedId,
              semanticKey: metadata.semanticKey,
              wireRequestId: metadata.wireRequestId,
              request,
              content: initialContent(request),
              step: 0,
              recovered: metadata.recovered,
              continuation: metadata.continuation,
              resolve,
              responderKey,
              deliveryClaim: null,
              persistenceScope: resolvedPersistenceScope,
              savedAt: Date.now(),
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
    if (promptAlreadyOwnsResponse) resolve({ action: "cancel" });
    return { id: attachedId, responderKey };
  },
  setValue: (sessionId, id, key, value) =>
    set((state) => {
      const queue = state.pendingBySessionId[sessionId];
      const presented = presentedElicitation(queue);
      // An event from a question that has since been withdrawn or replaced
      // must not land on whichever question took its place.
      if (!queue || presented?.id !== id || presented.deliveryClaim)
        return state;
      const content = { ...presented.content };
      if (value === undefined) delete content[key];
      else content[key] = value;
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: queue.map((pending) =>
            pending.id === presented.id ? { ...pending, content } : pending,
          ),
        },
      };
    }),
  setStep: (sessionId, id, step) =>
    set((state) => {
      const queue = state.pendingBySessionId[sessionId];
      const presented = presentedElicitation(queue);
      if (!queue || presented?.id !== id || presented.deliveryClaim)
        return state;
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: queue.map((pending) =>
            pending.id === presented.id
              ? { ...pending, step: Math.max(0, step) }
              : pending,
          ),
        },
      };
    }),
  accept: (sessionId, id) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!pending?.resolve || pending.deliveryClaim) return;
    set((state) => ({
      pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
    }));
    pending.resolve(acceptedElicitationResponse(pending));
  },
  decline: (sessionId, id) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!pending?.resolve || pending.deliveryClaim) return;
    set((state) => ({
      pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
    }));
    pending.resolve({ action: "decline" });
  },
  cancel: (sessionId, id) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    // Discarding a question whose answers are already on their way would leave
    // the message sent and the record gone.
    if (!pending || pending.deliveryClaim) return;
    set((state) => ({
      pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
    }));
    pending.resolve?.({ action: "cancel" });
  },
  retainUndeliveredAnswers: (
    request,
    content,
    persistenceScope,
    connectionIdentity,
  ) => {
    const resolvedPersistenceScope =
      persistenceScope ?? getElicitationPersistenceScope("unknown", 0);
    const resolvedConnectionIdentity = connectionIdentity ?? {
      providerId: resolvedPersistenceScope?.providerId ?? "unknown",
      connectionGeneration: resolvedPersistenceScope?.connectionGeneration ?? 0,
      connectionInstanceId:
        resolvedPersistenceScope?.connectionInstanceId ?? "unknown",
    };
    const metadata = getElicitationMetadata(
      request,
      undefined,
      resolvedConnectionIdentity,
    );
    set((state) => {
      const queue = state.pendingBySessionId[request.sessionId] ?? [];
      if (queue.some((pending) => pending.id === metadata.id)) return state;
      const restored: PendingElicitation = {
        id: uniquePendingId(queue, metadata.id),
        semanticKey: metadata.semanticKey,
        wireRequestId: null,
        request,
        content: contentWithoutSecrets(request, content),
        step: 0,
        recovered: true,
        continuation: "prompt",
        resolve: null,
        responderKey: null,
        deliveryClaim: null,
        persistenceScope: resolvedPersistenceScope,
        savedAt: Date.now(),
      };
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [request.sessionId]: [...queue, restored],
        },
      };
    });
  },
  claimDetachedDelivery: (sessionId, id) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    // Only a detached question can be sent this way, and only once: taking the
    // claim here is what stops a second send and a discard racing the first.
    if (!pending || pending.resolve !== null || pending.deliveryClaim) {
      return null;
    }
    const token = Symbol("elicitation-delivery");
    set((state) => ({
      pendingBySessionId: {
        ...state.pendingBySessionId,
        [sessionId]: (state.pendingBySessionId[sessionId] ?? []).map(
          (candidate) =>
            candidate.id === id
              ? {
                  ...candidate,
                  deliveryClaim: {
                    token,
                    phase: "claiming",
                    cancelled: false,
                  },
                }
              : candidate,
        ),
      },
    }));
    return token;
  },
  beginDetachedDelivery: (sessionId, id, token) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (
      !pending ||
      pending.deliveryClaim?.token !== token ||
      pending.deliveryClaim.phase !== "claiming"
    ) {
      return false;
    }

    // The live responder wins until the final reversible send boundary. Once
    // that boundary is crossed, the ordinary prompt owns the answer instead.
    if (pending.resolve) {
      set((state) => ({
        pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
      }));
      pending.resolve(acceptedElicitationResponse(pending));
      return false;
    }

    set((state) => ({
      pendingBySessionId: {
        ...state.pendingBySessionId,
        [sessionId]: (state.pendingBySessionId[sessionId] ?? []).map(
          (candidate) =>
            candidate.id === id && candidate.deliveryClaim?.token === token
              ? {
                  ...candidate,
                  deliveryClaim: {
                    ...candidate.deliveryClaim,
                    phase: "prompt-dispatched",
                  },
                }
              : candidate,
        ),
      },
    }));
    return true;
  },
  completeDetachedDelivery: (sessionId, id, token) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (
      !pending ||
      pending.deliveryClaim?.token !== token ||
      pending.deliveryClaim.phase !== "prompt-dispatched"
    ) {
      return;
    }
    set((state) => ({
      pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
    }));
    // The prompt already owns the answer. A responder that arrived afterward
    // must be settled without receiving a second accepted response.
    pending.resolve?.({ action: "cancel" });
  },
  failDetachedDelivery: (sessionId, id, token) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!pending || pending.deliveryClaim?.token !== token) return "ignored";
    if (pending.deliveryClaim.cancelled) {
      set((state) => ({
        pendingBySessionId: removeById(state.pendingBySessionId, sessionId, id),
      }));
      return "ignored";
    }
    if (
      pending.deliveryClaim.phase === "prompt-dispatched" ||
      pending.deliveryClaim.phase === "indeterminate"
    ) {
      set((state) => ({
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: (state.pendingBySessionId[sessionId] ?? []).map(
            (candidate) =>
              candidate.id === id && candidate.deliveryClaim?.token === token
                ? {
                    ...candidate,
                    resolve: null,
                    responderKey: null,
                    deliveryClaim: {
                      ...candidate.deliveryClaim,
                      phase: "indeterminate",
                    },
                  }
                : candidate,
          ),
        },
      }));
      // Crossing the dispatch boundary gives the prompt permanent ownership,
      // even when the transport cannot confirm its result. A late responder is
      // cancelled rather than becoming a second winner.
      pending.resolve?.({ action: "cancel" });
      return "indeterminate";
    }
    set((state) => ({
      pendingBySessionId: {
        ...state.pendingBySessionId,
        [sessionId]: (state.pendingBySessionId[sessionId] ?? []).map(
          (candidate) =>
            candidate.id === id && candidate.deliveryClaim?.token === token
              ? { ...candidate, deliveryClaim: null }
              : candidate,
        ),
      },
    }));
    return "retryable";
  },
  abort: (sessionId, id, responderKey) => {
    const pending = get().pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === id,
    );
    if (!pending || pending.responderKey !== responderKey) return;
    set((state) =>
      pending.deliveryClaim
        ? {
            pendingBySessionId: {
              ...state.pendingBySessionId,
              [sessionId]: (state.pendingBySessionId[sessionId] ?? []).map(
                (candidate) =>
                  candidate.id === id
                    ? { ...candidate, resolve: null, responderKey: null }
                    : candidate,
              ),
            },
          }
        : {
            pendingBySessionId: removeById(
              state.pendingBySessionId,
              sessionId,
              id,
            ),
          },
    );
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
      const next = { ...state.pendingBySessionId };
      for (const [id, queue] of Object.entries(state.pendingBySessionId)) {
        if (sessionId && id !== sessionId) continue;
        const inFlight = queue.flatMap((pending) =>
          pending.deliveryClaim?.phase === "prompt-dispatched"
            ? [
                {
                  ...pending,
                  resolve: null,
                  responderKey: null,
                  deliveryClaim: {
                    ...pending.deliveryClaim,
                    cancelled: true,
                  },
                },
              ]
            : [],
        );
        if (inFlight.length) next[id] = inFlight;
        else delete next[id];
      }
      return { pendingBySessionId: next };
    });
    for (const pending of Object.values(targets).flat()) {
      pending.resolve?.({ action: "cancel" });
    }
  },
}));

useElicitationStore.subscribe((state, previousState) =>
  schedulePersist(state.pendingBySessionId, previousState.pendingBySessionId),
);

/** Settle live work and stop persistence when an exact account/workspace
 * boundary is unavailable, without deleting drafts owned by known scopes. */
export function suspendElicitationPersistence(): void {
  useElicitationStore.getState().cancelAll();
  persistenceIdentity = null;
  hydratedPersistenceScopes.clear();
  if (typeof window !== "undefined" && persistenceTimer !== null) {
    window.clearTimeout(persistenceTimer);
    persistenceTimer = null;
  }
  pendingPersistQueues = null;
  pendingPersistDescriptors = new Map();
}

/** Forget every in-memory and persisted draft before the account boundary changes. */
export async function clearPersistedElicitations(): Promise<void> {
  suspendElicitationPersistence();
  try {
    window.localStorage.removeItem(ELICITATION_STORAGE_KEY);
    for (const key of LEGACY_ELICITATION_STORAGE_KEYS) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Best effort; the in-memory reset is what this session sees either way.
  }
  nativePersistenceEnvelope = null;
  if (usesNativePersistence()) {
    nativeWriteChain = nativeWriteChain
      .then(async () => {
        await invoke("clear_elicitation_persistence");
      })
      .catch(() => {
        // Best effort; the in-memory boundary still changes immediately.
      });
    await nativeWriteChain;
  }
}
