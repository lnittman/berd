import { z } from "zod";
import type { AuthStatus } from "@/features/auth/api/auth";

export const ELICITATION_STORAGE_KEY = "berd:pending-elicitations:v4";
export const LEGACY_ELICITATION_STORAGE_KEYS = [
  "berd:pending-elicitations:v1",
  "berd:pending-elicitations:v2",
  "berd:pending-elicitations:v3",
] as const;
export const ELICITATION_PERSISTENCE_VERSION = 4 as const;

export interface ElicitationPersistenceIdentityInput {
  accountId: string;
  workspaceId: string;
}

export const elicitationPersistenceScopeSchema = z.object({
  accountId: z.string().min(1),
  workspaceId: z.string().min(1),
  providerId: z.string().min(1),
  connectionGeneration: z.number().int().nonnegative(),
  connectionInstanceId: z.string().min(1),
});

export type ElicitationPersistenceScope = z.infer<
  typeof elicitationPersistenceScopeSchema
>;

export function persistenceIdentityFromAuthStatus(
  status: AuthStatus | undefined,
  workspaceOverride?: string | null,
): ElicitationPersistenceIdentityInput | null {
  if (!status) return { accountId: "local", workspaceId: "local" };
  if (!status.loggedIn) return null;
  // A display name is not an account boundary: two people can share it, and
  // providers may change it. Persist only when auth supplies a stable id or
  // email address.
  const accountId = status.userId ?? status.email;
  const workspaceId = workspaceOverride ?? status.workspaceIdentifier;
  if (!accountId?.trim() || !workspaceId?.trim()) return null;
  return { accountId, workspaceId };
}

const elicitationContentValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);

const formElicitationPropertySchema = z
  .object({ type: z.string().min(1) })
  .passthrough();

const formElicitationRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    mode: z.literal("form"),
    message: z.string(),
    requestedSchema: z
      .object({
        type: z.literal("object"),
        properties: z
          .record(z.string(), formElicitationPropertySchema)
          .optional(),
        required: z.array(z.string()).optional(),
      })
      .passthrough(),
    toolCallId: z.string().nullable().optional(),
    _meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const persistedElicitationSchema = z.object({
  id: z.string().min(1),
  semanticKey: z.string().min(1),
  wireRequestId: z.union([z.string(), z.number()]).nullable(),
  request: formElicitationRequestSchema,
  content: z.record(z.string(), elicitationContentValueSchema),
  step: z.number().int().nonnegative(),
  recovered: z.boolean(),
  continuation: z.enum(["response", "prompt"]),
  savedAt: z.number().finite(),
});

export const persistedScopeSchema = z.object({
  identity: elicitationPersistenceScopeSchema,
  queues: z.record(z.string(), z.array(persistedElicitationSchema)),
});

export const persistedElicitationSessionRecordSchema = z.object({
  identity: elicitationPersistenceScopeSchema,
  sessionId: z.string().min(1),
  queue: z.array(persistedElicitationSchema),
});

export const nativeElicitationPersistenceEnvelopeSchema = z.object({
  version: z.literal(ELICITATION_PERSISTENCE_VERSION),
  records: z.record(z.string(), persistedElicitationSessionRecordSchema),
});

export type PersistedElicitationSessionRecord = z.infer<
  typeof persistedElicitationSessionRecordSchema
>;

export type NativeElicitationPersistenceEnvelope = z.infer<
  typeof nativeElicitationPersistenceEnvelopeSchema
>;

export const persistedElicitationEnvelopeSchema = z.object({
  version: z.literal(ELICITATION_PERSISTENCE_VERSION),
  scopes: z.array(persistedScopeSchema),
});

export type PersistedElicitationEnvelope = z.infer<
  typeof persistedElicitationEnvelopeSchema
>;

export function persistenceScopeKey(
  scope: ElicitationPersistenceScope,
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    scope.providerId,
    scope.connectionGeneration,
    scope.connectionInstanceId,
  ]);
}

export function persistenceRecordKey(
  scope: ElicitationPersistenceScope,
  sessionId: string,
): string {
  return JSON.stringify([
    scope.accountId,
    scope.workspaceId,
    scope.providerId,
    scope.connectionGeneration,
    scope.connectionInstanceId,
    sessionId,
  ]);
}

export function sharesPersistenceNamespace(
  left: ElicitationPersistenceScope,
  right: ElicitationPersistenceScope,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.workspaceId === right.workspaceId &&
    left.providerId === right.providerId
  );
}
