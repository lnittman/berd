import { describe, expect, it, vi } from "vitest";
import {
  AgentSideConnection,
  ndJsonStream,
  type CreateElicitationRequest,
} from "@agentclientprotocol/sdk";
import { GooseClient } from "../../../../sdk/src/goose-client";

describe("GooseClient elicitation transport", () => {
  it("registers the ACP 1.3 form handler and returns its response", async () => {
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();
    const onElicitation = vi.fn(
      async (request: CreateElicitationRequest, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        expect(request).toMatchObject({
          sessionId: "session-1",
          mode: "form",
          message: "Choose the surfaces",
          requestedSchema: {
            type: "object",
            properties: {
              surfaces: {
                type: "array",
                items: { type: "string", enum: ["desktop", "cli"] },
              },
            },
          },
        });
        return {
          action: "accept" as const,
          content: { surfaces: ["desktop", "cli"] },
        };
      },
    );

    new GooseClient(
      () => ({
        requestPermission: async () => ({
          outcome: { outcome: "cancelled" },
        }),
        sessionUpdate: async () => undefined,
        unstable_createElicitation: onElicitation,
      }),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const agentConnection = new AgentSideConnection(
      () => ({
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
        }),
        newSession: async () => ({ sessionId: "session-1" }),
        loadSession: async () => ({}),
        authenticate: async () => ({}),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    await expect(
      agentConnection.unstable_createElicitation({
        sessionId: "session-1",
        mode: "form",
        message: "Choose the surfaces",
        requestedSchema: {
          type: "object",
          properties: {
            surfaces: {
              type: "array",
              items: { type: "string", enum: ["desktop", "cli"] },
            },
          },
        },
      }),
    ).resolves.toEqual({
      action: "accept",
      content: { surfaces: ["desktop", "cli"] },
    });
    expect(onElicitation).toHaveBeenCalledOnce();
  });

  it("delivers an optional capability the consumer implements", async () => {
    // Every Client member except requestPermission and sessionUpdate is
    // optional. Supplying one has to be enough to start receiving it, or a
    // consumer can implement a capability that is silently never called.
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();
    const readTextFile = vi.fn(async () => ({ content: "berd" }));

    new GooseClient(
      () => ({
        requestPermission: async () => ({
          outcome: { outcome: "cancelled" },
        }),
        sessionUpdate: async () => undefined,
        readTextFile,
      }),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const agentConnection = new AgentSideConnection(
      () => ({
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
        }),
        newSession: async () => ({ sessionId: "session-1" }),
        loadSession: async () => ({}),
        authenticate: async () => ({}),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    await expect(
      agentConnection.readTextFile({
        sessionId: "session-1",
        path: "/tmp/berd.txt",
      }),
    ).resolves.toEqual({ content: "berd" });
    expect(readTextFile).toHaveBeenCalledOnce();
  });

  it("delivers registered extension requests and notifications", async () => {
    const clientToAgent = new TransformStream();
    const agentToClient = new TransformStream();
    const extensionRequest = vi.fn(
      async (params: Record<string, unknown>, signal: AbortSignal) => {
        expect(signal.aborted).toBe(false);
        return { echoed: params.message };
      },
    );
    const extensionNotification = vi.fn(
      async (_params: Record<string, unknown>) => undefined,
    );

    new GooseClient(
      () => ({
        requestPermission: async () => ({
          outcome: { outcome: "cancelled" },
        }),
        sessionUpdate: async () => undefined,
        extensionRequests: {
          "vendor/client-echo": extensionRequest,
        },
        extensionNotifications: {
          "vendor/client-note": extensionNotification,
        },
      }),
      ndJsonStream(clientToAgent.writable, agentToClient.readable),
    );
    const agentConnection = new AgentSideConnection(
      () => ({
        initialize: async () => ({
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
        }),
        newSession: async () => ({ sessionId: "session-1" }),
        loadSession: async () => ({}),
        authenticate: async () => ({}),
        prompt: async () => ({ stopReason: "end_turn" }),
        cancel: async () => undefined,
      }),
      ndJsonStream(agentToClient.writable, clientToAgent.readable),
    );

    await expect(
      agentConnection.request("vendor/client-echo", { message: "berd" }),
    ).resolves.toEqual({ echoed: "berd" });
    await agentConnection.notify("vendor/client-note", {
      message: "received",
    });

    expect(extensionRequest).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(extensionNotification).toHaveBeenCalledWith({
        message: "received",
      });
    });
  });
});
