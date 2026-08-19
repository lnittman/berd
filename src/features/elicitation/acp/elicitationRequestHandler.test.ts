import { beforeEach, describe, expect, it } from "vitest";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { handleElicitationRequest } from "./elicitationRequestHandler";
import { useElicitationStore } from "../stores/elicitationStore";

const request: CreateElicitationRequest = {
  mode: "form",
  sessionId: "session-1",
  message: "Choose a direction",
  requestedSchema: {
    type: "object",
    properties: {
      direction: {
        type: "string",
        oneOf: [
          { const: "local", title: "Local proof" },
          { const: "issue", title: "Upstream issue" },
        ],
      },
    },
    required: ["direction"],
  },
};

describe("handleElicitationRequest", () => {
  beforeEach(() => useElicitationStore.setState({ pendingBySessionId: {} }));

  it("queues a form and returns the accepted structured content", async () => {
    const response = handleElicitationRequest(request);
    const store = useElicitationStore.getState();
    expect(store.pendingBySessionId["session-1"]).toHaveLength(1);

    store.setValue("session-1", "direction", "local");
    store.accept("session-1");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction: "local" },
    });
  });

  it("returns cancel for unsupported URL elicitation", async () => {
    await expect(
      handleElicitationRequest({
        mode: "url",
        sessionId: "session-1",
        message: "Authenticate",
        url: "https://example.com",
        elicitationId: "auth-1",
      }),
    ).resolves.toEqual({ action: "cancel" });
  });

  it("resolves every pending request as cancelled on teardown", async () => {
    const first = handleElicitationRequest(request);
    const second = handleElicitationRequest(request);
    useElicitationStore.getState().cancelAll("session-1");
    await expect(Promise.all([first, second])).resolves.toEqual([
      { action: "cancel" },
      { action: "cancel" },
    ]);
  });
});
