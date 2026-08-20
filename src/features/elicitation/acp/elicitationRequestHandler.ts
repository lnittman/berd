import {
  CreateElicitationRequest,
  RequestError,
  type CreateElicitationResponse,
  type ElicitationContentValue,
} from "@agentclientprotocol/sdk";
import { continueRecoveredElicitation } from "@/features/elicitation/lib/recoveredElicitationContinuation";
import { elicitationBoundsViolation } from "@/features/elicitation/lib/elicitationSchemaLimits";
import {
  getElicitationPersistenceScope,
  getElicitationMetadata,
  useElicitationStore,
} from "@/features/elicitation/stores/elicitationStore";
import { getPreparedProviderId } from "@/shared/api/acpSessionRegistry";

function isExplicitRequestCancellation(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  if (reason instanceof RequestError) return reason.code === -32800;
  // Two physical copies of the SDK would defeat instanceof and silently
  // reclassify an explicit cancel as connection loss, stranding the form.
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { code?: unknown }).code === -32800
  );
}

export function handleElicitationRequest(
  request: CreateElicitationRequest,
  signal?: AbortSignal,
  wireRequestId?: string | number,
  connection?: {
    connectionGeneration: number;
    connectionInstanceId: string;
  },
): Promise<CreateElicitationResponse> {
  // A mode or scope Berd does not implement is a client limitation, not a
  // decision the user made. Answering "cancel" would tell the agent its
  // question was declined; invalid params tells it the truth.
  if (!CreateElicitationRequest.isForm(request)) {
    return Promise.reject(
      RequestError.invalidParams(
        { supported: { mode: "form" } },
        "Berd advertises form elicitation only",
      ),
    );
  }
  if (!("sessionId" in request)) {
    return Promise.reject(
      RequestError.invalidParams(
        { supported: { scope: "session" } },
        "Berd supports session-scoped form elicitation only",
      ),
    );
  }
  const boundsViolation = elicitationBoundsViolation(
    request.message,
    request.requestedSchema,
  );
  if (boundsViolation) {
    return Promise.reject(
      RequestError.invalidParams(
        { elicitationLimit: boundsViolation },
        "Elicitation form exceeds Berd's supported limits",
      ),
    );
  }
  if (signal?.aborted) return Promise.resolve({ action: "cancel" });

  const connectionIdentity = {
    providerId: getPreparedProviderId(request.sessionId) ?? "unknown",
    connectionGeneration: connection?.connectionGeneration ?? 0,
    connectionInstanceId: connection?.connectionInstanceId ?? "unknown",
  };
  const metadata = getElicitationMetadata(
    request,
    wireRequestId,
    connectionIdentity,
  );
  const persistenceScope = getElicitationPersistenceScope(
    connectionIdentity.providerId,
    connectionIdentity.connectionGeneration,
    connectionIdentity.connectionInstanceId,
  );
  let pendingId: string;
  let responderKey: symbol;
  const response = new Promise<CreateElicitationResponse>((resolve) => {
    const responder = useElicitationStore.getState().enqueue({
      request,
      resolve,
      wireRequestId,
      persistenceScope,
      connectionIdentity,
    });
    pendingId = responder.id;
    responderKey = responder.responderKey;
  });
  const abort = () => {
    // Incoming request signals also abort when the ACP connection closes. In
    // that case the connection monitor detaches the form so its draft can be
    // recovered; only an explicit JSON-RPC request cancellation is terminal.
    if (!signal || !isExplicitRequestCancellation(signal)) return;
    useElicitationStore
      .getState()
      .abort(request.sessionId, pendingId, responderKey);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  return response
    .then((result) => {
      if (metadata.recovered && metadata.continuation === "prompt") {
        window.setTimeout(() => {
          void continueRecoveredElicitation(request, result).catch((error) => {
            console.error("Failed to continue recovered elicitation:", error);
            // The pending was already removed when the answer was accepted, so
            // without this the answers are gone with nothing on screen. Put
            // them back as a detached draft the user can retry or discard.
            if (result.action === "accept") {
              useElicitationStore
                .getState()
                .retainUndeliveredAnswers(
                  request,
                  (result.content ?? {}) as Record<
                    string,
                    ElicitationContentValue
                  >,
                  persistenceScope,
                  connectionIdentity,
                );
            }
          });
        }, 0);
      }
      return result;
    })
    .finally(() => signal?.removeEventListener("abort", abort));
}
