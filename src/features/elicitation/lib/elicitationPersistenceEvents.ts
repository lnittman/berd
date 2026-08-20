import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ElicitationPersistenceIdentityInput } from "@/features/elicitation/lib/elicitationPersistence";

const ELICITATION_PERSISTENCE_IDENTITY_EVENT =
  "elicitation:persistence-identity-changed";

export interface ElicitationPersistenceIdentityEvent {
  identity: ElicitationPersistenceIdentityInput | null;
}

export async function broadcastElicitationPersistenceIdentity(
  identity: ElicitationPersistenceIdentityInput | null,
): Promise<void> {
  if (!window.__TAURI_INTERNALS__) return;
  try {
    await emit(ELICITATION_PERSISTENCE_IDENTITY_EVENT, { identity });
  } catch (error) {
    console.warn(
      "Failed to broadcast elicitation persistence identity:",
      error,
    );
  }
}

export function listenElicitationPersistenceIdentity(
  handler: (identity: ElicitationPersistenceIdentityInput | null) => void,
): Promise<UnlistenFn> {
  if (!window.__TAURI_INTERNALS__) return Promise.resolve(() => {});
  return listen<ElicitationPersistenceIdentityEvent>(
    ELICITATION_PERSISTENCE_IDENTITY_EVENT,
    (event) => handler(event.payload.identity),
  );
}
