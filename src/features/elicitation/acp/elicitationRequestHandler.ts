import {
  CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { continueRecoveredElicitation } from "@/features/elicitation/lib/recoveredElicitationContinuation";
import { useElicitationStore } from "@/features/elicitation/stores/elicitationStore";

export function handleElicitationRequest(
  request: CreateElicitationRequest,
): Promise<CreateElicitationResponse> {
  if (!CreateElicitationRequest.isForm(request) || !("sessionId" in request)) {
    return Promise.resolve({ action: "cancel" });
  }

  const response = new Promise<CreateElicitationResponse>((resolve) => {
    useElicitationStore.getState().enqueue({ request, resolve });
  });

  return response.then((result) => {
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
  });
}
