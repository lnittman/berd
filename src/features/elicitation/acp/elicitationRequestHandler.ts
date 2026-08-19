import {
  CreateElicitationRequest,
  RequestError,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { continueRecoveredElicitation } from "@/features/elicitation/lib/recoveredElicitationContinuation";
import {
  getElicitationMetadata,
  useElicitationStore,
} from "@/features/elicitation/stores/elicitationStore";

function isExplicitRequestCancellation(signal: AbortSignal): boolean {
  return signal.reason instanceof RequestError && signal.reason.code === -32800;
}

export function handleElicitationRequest(
  request: CreateElicitationRequest,
  signal?: AbortSignal,
): Promise<CreateElicitationResponse> {
  if (!CreateElicitationRequest.isForm(request) || !("sessionId" in request)) {
    return Promise.resolve({ action: "cancel" });
  }
  if (signal?.aborted) return Promise.resolve({ action: "cancel" });

  const metadata = getElicitationMetadata(request);
  let responderKey: symbol;
  const response = new Promise<CreateElicitationResponse>((resolve) => {
    responderKey = useElicitationStore.getState().enqueue({ request, resolve });
  });
  const abort = () => {
    // Incoming request signals also abort when the ACP connection closes. In
    // that case the connection monitor detaches the form so its draft can be
    // recovered; only an explicit JSON-RPC request cancellation is terminal.
    if (!signal || !isExplicitRequestCancellation(signal)) return;
    useElicitationStore
      .getState()
      .abort(request.sessionId, metadata.id, responderKey);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  return response
    .then((result) => {
      const goose = request._meta?.goose;
      if (
        goose != null &&
        typeof goose === "object" &&
        "continuation" in goose &&
        goose.continuation === "prompt"
      ) {
        window.setTimeout(() => {
          void continueRecoveredElicitation(request, result).catch((error) => {
            console.error("Failed to continue recovered elicitation:", error);
          });
        }, 0);
      }
      return result;
    })
    .finally(() => signal?.removeEventListener("abort", abort));
}
