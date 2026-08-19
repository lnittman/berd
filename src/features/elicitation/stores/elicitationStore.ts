import { create } from "zustand";
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";

export interface PendingElicitation {
  request: CreateElicitationRequest & {
    sessionId: string;
    mode: "form";
    requestedSchema: ElicitationSchema;
  };
  content: Record<string, ElicitationContentValue>;
  step: number;
  resolve: (response: CreateElicitationResponse) => void;
}

interface ElicitationState {
  pendingBySessionId: Record<string, PendingElicitation[]>;
  enqueue: (pending: Omit<PendingElicitation, "content" | "step">) => void;
  setValue: (
    sessionId: string,
    key: string,
    value: ElicitationContentValue,
  ) => void;
  setStep: (sessionId: string, step: number) => void;
  accept: (sessionId: string) => void;
  cancel: (sessionId: string) => void;
  cancelAll: (sessionId?: string) => void;
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

export const useElicitationStore = create<ElicitationState>((set, get) => ({
  pendingBySessionId: {},
  enqueue: (pending) =>
    set((state) => ({
      pendingBySessionId: {
        ...state.pendingBySessionId,
        [pending.request.sessionId]: [
          ...(state.pendingBySessionId[pending.request.sessionId] ?? []),
          { ...pending, content: {}, step: 0 },
        ],
      },
    })),
  setValue: (sessionId, key, value) =>
    set((state) => {
      const queue = state.pendingBySessionId[sessionId];
      if (!queue?.[0]) return state;
      return {
        pendingBySessionId: {
          ...state.pendingBySessionId,
          [sessionId]: [
            { ...queue[0], content: { ...queue[0].content, [key]: value } },
            ...queue.slice(1),
          ],
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
          [sessionId]: [{ ...queue[0], step }, ...queue.slice(1)],
        },
      };
    }),
  accept: (sessionId) => {
    const pending = get().pendingBySessionId[sessionId]?.[0];
    if (!pending) return;
    set((state) => ({
      pendingBySessionId: removeFirst(state.pendingBySessionId, sessionId),
    }));
    pending.resolve({ action: "accept", content: pending.content });
  },
  cancel: (sessionId) => {
    const pending = get().pendingBySessionId[sessionId]?.[0];
    if (!pending) return;
    set((state) => ({
      pendingBySessionId: removeFirst(state.pendingBySessionId, sessionId),
    }));
    pending.resolve({ action: "cancel" });
  },
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
      pending.resolve({ action: "cancel" });
    }
  },
}));
