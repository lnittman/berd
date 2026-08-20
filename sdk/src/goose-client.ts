import {
  client,
  methods,
  type Client,
  type ClientConnection,
  type Stream,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type MaybePromise,
} from "@agentclientprotocol/sdk";
import { z } from "zod";
import { GooseExtClient } from "./generated/client.gen.js";
import { createHttpStream } from "./http-stream.js";

export type GooseClientCallbacks = Omit<
  Client,
  "extMethod" | "extNotification" | "unstable_createElicitation"
> & {
  unstable_createElicitation?: (
    params: CreateElicitationRequest,
    signal: AbortSignal,
    /** JSON-RPC id of this request, for correlating concurrent questions. */
    requestId?: string | number,
  ) => Promise<CreateElicitationResponse>;
  extensionRequests?: Record<
    string,
    (
      params: Record<string, unknown>,
      signal: AbortSignal,
      requestId?: string | number,
    ) => MaybePromise<Record<string, unknown>>
  >;
  extensionNotifications?: Record<
    string,
    (params: Record<string, unknown>) => MaybePromise<void>
  >;
};

const extensionParamsSchema = z.record(z.string(), z.unknown());

export class GooseClient {
  private conn: ClientConnection;
  private ext: GooseExtClient;

  constructor(
    toClient: () => GooseClientCallbacks,
    streamOrUrl: Stream | string,
  ) {
    const stream =
      typeof streamOrUrl === "string"
        ? createHttpStream(streamOrUrl)
        : streamOrUrl;
    const callbacks = toClient();
    let app = client({ name: "berd" })
      .onRequest(methods.client.session.requestPermission, ({ params }) =>
        callbacks.requestPermission(params),
      )
      .onNotification(methods.client.session.update, ({ params }) =>
        callbacks.sessionUpdate(params),
      );
    const createElicitation = callbacks.unstable_createElicitation;
    if (createElicitation) {
      app = app.onRequest(
        methods.client.elicitation.create,
        ({ params, signal, requestId }) =>
          createElicitation(
            params,
            signal,
            typeof requestId === "string" || typeof requestId === "number"
              ? requestId
              : undefined,
          ),
      );
    }
    // Every other Client method is optional, so register exactly the ones the
    // consumer supplied. Without this a caller can implement a capability, see
    // it type-check, and never be called.
    const { readTextFile, writeTextFile } = callbacks;
    if (readTextFile) {
      app = app.onRequest(methods.client.fs.readTextFile, ({ params }) =>
        readTextFile(params),
      );
    }
    if (writeTextFile) {
      app = app.onRequest(
        methods.client.fs.writeTextFile,
        async ({ params }) => (await writeTextFile(params)) ?? {},
      );
    }
    const {
      createTerminal,
      terminalOutput,
      releaseTerminal,
      waitForTerminalExit,
      killTerminal,
      unstable_completeElicitation: completeElicitation,
    } = callbacks;
    if (createTerminal) {
      app = app.onRequest(methods.client.terminal.create, ({ params }) =>
        createTerminal(params),
      );
    }
    if (terminalOutput) {
      app = app.onRequest(methods.client.terminal.output, ({ params }) =>
        terminalOutput(params),
      );
    }
    if (releaseTerminal) {
      app = app.onRequest(
        methods.client.terminal.release,
        async ({ params }) => (await releaseTerminal(params)) ?? {},
      );
    }
    if (waitForTerminalExit) {
      app = app.onRequest(methods.client.terminal.waitForExit, ({ params }) =>
        waitForTerminalExit(params),
      );
    }
    if (killTerminal) {
      app = app.onRequest(
        methods.client.terminal.kill,
        async ({ params }) => (await killTerminal(params)) ?? {},
      );
    }
    if (completeElicitation) {
      app = app.onNotification(
        methods.client.elicitation.complete,
        ({ params }) => completeElicitation(params),
      );
    }
    for (const [method, handler] of Object.entries(
      callbacks.extensionRequests ?? {},
    )) {
      app = app.onRequest(
        method,
        extensionParamsSchema,
        ({ params, signal, requestId }) =>
          handler(
            params,
            signal,
            typeof requestId === "string" || typeof requestId === "number"
              ? requestId
              : undefined,
          ),
      );
    }
    for (const [method, handler] of Object.entries(
      callbacks.extensionNotifications ?? {},
    )) {
      app = app.onNotification(method, extensionParamsSchema, ({ params }) =>
        handler(params),
      );
    }
    this.conn = app.connect(stream);
    this.ext = new GooseExtClient({
      extMethod: (method, params) =>
        this.conn.agent.request<
          Record<string, unknown>,
          Record<string, unknown>
        >(method, params),
    });
  }

  get signal(): AbortSignal {
    return this.conn.signal;
  }

  get closed(): Promise<void> {
    return this.conn.closed;
  }

  initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return this.conn.agent.request(methods.agent.initialize, params);
  }

  newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    return this.conn.agent.request(methods.agent.session.new, params);
  }

  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    return this.conn.agent.request(methods.agent.session.load, params);
  }

  prompt(params: PromptRequest): Promise<PromptResponse> {
    return this.conn.agent.request(methods.agent.session.prompt, params);
  }

  cancel(params: CancelNotification): Promise<void> {
    return this.conn.agent.notify(methods.agent.session.cancel, params);
  }

  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return this.conn.agent.request(methods.agent.authenticate, params);
  }

  setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse> {
    return this.conn.agent.request(methods.agent.session.setMode, params);
  }

  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    return this.conn.agent.request(
      methods.agent.session.setConfigOption,
      params,
    );
  }

  unstable_forkSession(
    params: ForkSessionRequest,
  ): Promise<ForkSessionResponse> {
    return this.conn.agent.request(methods.agent.session.fork, params);
  }

  listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.conn.agent.request(methods.agent.session.list, params);
  }

  unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    return this.conn.agent.request(methods.agent.session.resume, params);
  }

  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return this.conn.agent.request<
      Record<string, unknown>,
      Record<string, unknown>
    >(method, params);
  }

  get goose(): GooseExtClient {
    return this.ext;
  }
}
