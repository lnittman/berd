import {
  CreateElicitationRequest,
  type CreateElicitationResponse,
} from "@agentclientprotocol/sdk";
import { useElicitationStore } from "@/features/elicitation/stores/elicitationStore";

export function handleElicitationRequest(
  request: CreateElicitationRequest,
): Promise<CreateElicitationResponse> {
  if (!CreateElicitationRequest.isForm(request) || !("sessionId" in request)) {
    return Promise.resolve({ action: "cancel" });
  }

  return new Promise((resolve) => {
    useElicitationStore.getState().enqueue({ request, resolve });
  });
}
