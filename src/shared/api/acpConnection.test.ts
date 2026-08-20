import { describe, expect, it, vi } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import {
  createClientCallbacksForTests,
  setElicitationHandler,
} from "./acpConnection";

describe("ACP connection elicitation identity", () => {
  it("passes the physical client connection identity to each request", async () => {
    const handler = vi.fn().mockResolvedValue({ action: "cancel" });
    setElicitationHandler(handler);
    const callbacks = createClientCallbacksForTests(9, "connection-instance-9");
    const request = {
      mode: "form",
      sessionId: "session-1",
      message: "Choose",
      requestedSchema: { type: "object", properties: {} },
    } satisfies CreateElicitationRequest;
    const signal = new AbortController().signal;

    await callbacks.unstable_createElicitation?.(request, signal, 41);

    expect(handler).toHaveBeenCalledWith(request, signal, 41, {
      connectionGeneration: 9,
      connectionInstanceId: "connection-instance-9",
    });
  });
});
