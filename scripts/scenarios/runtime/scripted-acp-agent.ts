import {
  PROTOCOL_VERSION,
  RequestError,
  agent,
  methods,
  ndJsonStream,
  type AgentContext,
  type PromptResponse,
} from "@agentclientprotocol/sdk";
import { writeFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { Readable, Writable } from "node:stream";
import { z } from "zod";

const scenarioSchema = z.object({
  sessionId: z.string().min(1).default("scripted-root-session"),
  sessionLifecycle: z
    .object({
      load: z.boolean().default(false),
      list: z.boolean().default(false),
      delete: z.boolean().default(false),
      fork: z.boolean().default(false),
      resume: z.boolean().default(false),
      close: z.boolean().default(false),
      loadReplay: z.array(z.string()).default([]),
    })
    .default({
      load: false,
      list: false,
      delete: false,
      fork: false,
      resume: false,
      close: false,
      loadReplay: [],
    }),
  sessionModes: z
    .object({ currentModeId: z.string(), availableModeIds: z.array(z.string()).min(1) })
    .optional(),
  sessionConfig: z
    .object({ id: z.string(), currentValue: z.string(), values: z.array(z.string()).min(1) })
    .optional(),
  initializeProtocolVersion: z.number().int().optional(),
  beforePrompt: z.array(z.string()).default([]),
  foreignSessionUpdates: z.array(z.string()).default([]),
  replayUpdate: z.object({ text: z.string(), count: z.number().int().min(1).max(32) }).optional(),
  requestPermission: z.boolean().default(false),
  authMethodId: z.string().min(1).optional(),
  authMethodIds: z.array(z.string().min(1)).min(1).optional(),
  requireAuthenticationBeforeSession: z.boolean().default(false),
  authenticationResult: z.enum(["success", "failure", "cancelled"]).default("success"),
  fsRead: z
    .object({
      path: z.string(),
      line: z.number().int().positive().optional(),
      limit: z.number().int().nonnegative().optional(),
    })
    .optional(),
  fsWrite: z.object({ path: z.string(), content: z.string() }).optional(),
  terminal: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      cwd: z.string().optional(),
      outputByteLimit: z.number().int().positive().optional(),
      kill: z.boolean().default(false),
    })
    .optional(),
  elicitation: z.enum(["form", "url"]).optional(),
  malformedBeforeInitialize: z.boolean().default(false),
  crashOnPrompt: z.boolean().default(false),
  failFirstPromptRequest: z.boolean().default(false),
  waitForCancel: z.boolean().default(false),
  afterCancel: z.array(z.string()).default([]),
  stopReason: z
    .enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
    .default("end_turn"),
});

export type ScriptedAcpScenario = z.input<typeof scenarioSchema>;

type Observation =
  | {
      readonly method: "initialize";
      readonly protocolVersion: number;
      readonly clientCapabilities: unknown;
    }
  | { readonly method: "session/new"; readonly cwd: string }
  | { readonly method: "session/load"; readonly sessionId: string }
  | { readonly method: "session/resume"; readonly sessionId: string }
  | { readonly method: "session/fork"; readonly sessionId: string }
  | { readonly method: "session/list" }
  | { readonly method: "session/delete"; readonly sessionId: string }
  | { readonly method: "session/close"; readonly sessionId: string }
  | { readonly method: "session/set_mode"; readonly modeId: string }
  | { readonly method: "session/set_config_option"; readonly configId: string }
  | { readonly method: "session/prompt"; readonly sessionId: string }
  | { readonly method: "authenticate"; readonly methodId: string }
  | { readonly method: "session/request_permission"; readonly outcome: string }
  | { readonly method: "fs/read_text_file"; readonly content: string }
  | { readonly method: "fs/write_text_file" }
  | {
      readonly method: "terminal";
      readonly output: string;
      readonly truncated: boolean;
      readonly exitCode: number | null | undefined;
    }
  | { readonly method: "elicitation/create"; readonly mode: string; readonly action: string }
  | { readonly method: "elicitation/complete"; readonly elicitationId: string }
  | { readonly method: "session/cancel"; readonly sessionId: string };

const loadScenario = (): z.output<typeof scenarioSchema> => {
  const encoded = process.env.NODEX_SCRIPTED_ACP_SCENARIO;
  if (encoded === undefined) throw new Error("NODEX_SCRIPTED_ACP_SCENARIO is required");
  return scenarioSchema.parse(JSON.parse(encoded));
};

/** Runs a deterministic stdio ACP peer for process-boundary tests. */
export const runScriptedAcpAgent = (): void => {
  const scenario = loadScenario();
  if (scenario.malformedBeforeInitialize) process.stdout.write("{malformed-acp-record\n");
  const observationPath = process.env.NODEX_SCRIPTED_ACP_OBSERVATION;
  const observations: Observation[] = [];
  let phase: "boot" | "initialized" | "session" | "prompting" = "boot";
  const cancellationEvents = new EventEmitter();
  let authenticated = false;
  let promptRequestFailed = false;

  const observe = (event: Observation): void => {
    observations.push(event);
    if (observationPath !== undefined) {
      writeFileSync(observationPath, `${JSON.stringify(observations)}\n`, "utf8");
    }
  };
  const authMethodIds =
    scenario.authMethodIds ?? (scenario.authMethodId === undefined ? [] : [scenario.authMethodId]);
  const assertPhase = (expected: typeof phase, method: string): void => {
    if (phase === expected) return;
    throw new Error(`Unexpected ${method} while scripted ACP agent is ${phase}`);
  };
  const sendText = (client: AgentContext, sessionId: string, text: string): Promise<void> =>
    client.notify(methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  const sendAll = (
    client: AgentContext,
    sessionId: string,
    texts: readonly string[],
  ): Promise<void> =>
    texts.reduce(
      (previous, text) => previous.then(() => sendText(client, sessionId, text)),
      Promise.resolve(),
    );
  const sessionState = () => ({
    ...(scenario.sessionModes === undefined
      ? {}
      : {
          modes: {
            currentModeId: scenario.sessionModes.currentModeId,
            availableModes: scenario.sessionModes.availableModeIds.map((id) => ({ id, name: id })),
          },
        }),
    ...(scenario.sessionConfig === undefined
      ? {}
      : {
          configOptions: [
            {
              id: scenario.sessionConfig.id,
              name: scenario.sessionConfig.id,
              type: "select" as const,
              currentValue: scenario.sessionConfig.currentValue,
              options: scenario.sessionConfig.values.map((value) => ({ value, name: value })),
            },
          ],
        }),
  });

  const application = agent({ name: "nodex-scripted-acp-agent" })
    .onRequest(methods.agent.initialize, (context) => {
      assertPhase("boot", "initialize");
      phase = "initialized";
      observe({
        method: "initialize",
        protocolVersion: context.params.protocolVersion,
        clientCapabilities: context.params.clientCapabilities,
      });
      return {
        protocolVersion: scenario.initializeProtocolVersion ?? PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: scenario.sessionLifecycle.load,
          sessionCapabilities: {
            ...(scenario.sessionLifecycle.list ? { list: {} } : {}),
            ...(scenario.sessionLifecycle.delete ? { delete: {} } : {}),
            ...(scenario.sessionLifecycle.fork ? { fork: {} } : {}),
            ...(scenario.sessionLifecycle.resume ? { resume: {} } : {}),
            ...(scenario.sessionLifecycle.close ? { close: {} } : {}),
          },
        },
        ...(authMethodIds.length === 0
          ? {}
          : {
              authMethods: authMethodIds.map((id) => ({
                id,
                name: `Scripted authentication ${id}`,
              })),
            }),
      };
    })
    .onRequest(methods.agent.authenticate, (context) => {
      if (!authMethodIds.includes(context.params.methodId)) {
        throw new Error(`Unexpected authentication method ${context.params.methodId}`);
      }
      observe({ method: "authenticate", methodId: context.params.methodId });
      if (scenario.authenticationResult === "failure") {
        throw RequestError.authRequired(undefined, "Scripted authentication failed");
      }
      if (scenario.authenticationResult === "cancelled") {
        throw RequestError.requestCancelled(undefined, "Scripted authentication cancelled");
      }
      authenticated = true;
      return {};
    })
    .onRequest(methods.agent.session.new, (context) => {
      assertPhase("initialized", "session/new");
      observe({ method: "session/new", cwd: context.params.cwd });
      if (scenario.requireAuthenticationBeforeSession && !authenticated) {
        throw RequestError.authRequired();
      }
      phase = "session";
      return { sessionId: scenario.sessionId, ...sessionState() };
    })
    .onRequest(methods.agent.session.load, async (context) => {
      assertPhase("initialized", "session/load");
      observe({ method: "session/load", sessionId: context.params.sessionId });
      if (scenario.requireAuthenticationBeforeSession && !authenticated) {
        throw RequestError.authRequired();
      }
      phase = "session";
      await sendAll(context.client, context.params.sessionId, scenario.sessionLifecycle.loadReplay);
      return sessionState();
    })
    .onRequest(methods.agent.session.resume, (context) => {
      assertPhase("initialized", "session/resume");
      observe({ method: "session/resume", sessionId: context.params.sessionId });
      if (scenario.requireAuthenticationBeforeSession && !authenticated) {
        throw RequestError.authRequired();
      }
      phase = "session";
      return sessionState();
    })
    .onRequest(methods.agent.session.fork, (context) => {
      assertPhase("initialized", "session/fork");
      observe({ method: "session/fork", sessionId: context.params.sessionId });
      if (scenario.requireAuthenticationBeforeSession && !authenticated) {
        throw RequestError.authRequired();
      }
      phase = "session";
      return { sessionId: scenario.sessionId, ...sessionState() };
    })
    .onRequest(methods.agent.session.list, () => {
      observe({ method: "session/list" });
      return {
        sessions: [{ sessionId: scenario.sessionId, cwd: process.cwd(), title: "Scripted" }],
      };
    })
    .onRequest(methods.agent.session.delete, (context) => {
      observe({ method: "session/delete", sessionId: context.params.sessionId });
      return {};
    })
    .onRequest(methods.agent.session.close, (context) => {
      observe({ method: "session/close", sessionId: context.params.sessionId });
      phase = "initialized";
      return {};
    })
    .onRequest(methods.agent.session.setMode, (context) => {
      observe({ method: "session/set_mode", modeId: context.params.modeId });
      return {};
    })
    .onRequest(methods.agent.session.setConfigOption, (context) => {
      observe({ method: "session/set_config_option", configId: context.params.configId });
      return { configOptions: sessionState().configOptions ?? [] };
    })
    .onRequest(methods.agent.session.prompt, (context) => {
      assertPhase("session", "session/prompt");
      if (context.params.sessionId !== scenario.sessionId) {
        throw new Error(`Unexpected root session ${context.params.sessionId}`);
      }
      observe({ method: "session/prompt", sessionId: context.params.sessionId });
      if (scenario.failFirstPromptRequest && !promptRequestFailed) {
        promptRequestFailed = true;
        throw RequestError.internalError(undefined, "Scripted prompt rejection");
      }
      phase = "prompting";
      const cancellation = once(cancellationEvents, "cancel").then(() => undefined);

      if (scenario.crashOnPrompt) {
        setImmediate(() => process.exit(17));
        return new Promise<PromptResponse>(() => undefined);
      }

      let turn = sendAll(context.client, context.params.sessionId, scenario.beforePrompt).then(() =>
        sendAll(
          context.client,
          `${context.params.sessionId}:foreign`,
          scenario.foreignSessionUpdates,
        ),
      );
      if (scenario.replayUpdate !== undefined) {
        turn = turn.then(() =>
          sendAll(
            context.client,
            context.params.sessionId,
            Array.from({ length: scenario.replayUpdate!.count }, () => scenario.replayUpdate!.text),
          ),
        );
      }
      if (scenario.requestPermission) {
        turn = turn.then(() =>
          context.client
            .request(methods.client.session.requestPermission, {
              sessionId: context.params.sessionId,
              toolCall: {
                toolCallId: "scripted-tool",
                title: "Scripted write",
                kind: "edit",
                status: "pending",
              },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            })
            .then((response) => {
              observe({
                method: "session/request_permission",
                outcome: response.outcome.outcome,
              });
            }),
        );
      }
      if (scenario.fsWrite !== undefined) {
        turn = turn.then(() =>
          context.client
            .request(methods.client.fs.writeTextFile, {
              sessionId: context.params.sessionId,
              path: scenario.fsWrite!.path,
              content: scenario.fsWrite!.content,
            })
            .then(() => observe({ method: "fs/write_text_file" })),
        );
      }
      if (scenario.fsRead !== undefined) {
        turn = turn.then(() =>
          context.client
            .request(methods.client.fs.readTextFile, {
              sessionId: context.params.sessionId,
              path: scenario.fsRead!.path,
              ...(scenario.fsRead!.line === undefined ? {} : { line: scenario.fsRead!.line }),
              ...(scenario.fsRead!.limit === undefined ? {} : { limit: scenario.fsRead!.limit }),
            })
            .then(({ content }) => observe({ method: "fs/read_text_file", content })),
        );
      }
      if (scenario.terminal !== undefined) {
        turn = turn.then(async () => {
          const created = await context.client.request(methods.client.terminal.create, {
            sessionId: context.params.sessionId,
            command: scenario.terminal!.command,
            args: scenario.terminal!.args,
            ...(scenario.terminal!.cwd === undefined ? {} : { cwd: scenario.terminal!.cwd }),
            ...(scenario.terminal!.outputByteLimit === undefined
              ? {}
              : { outputByteLimit: scenario.terminal!.outputByteLimit }),
          });
          if (scenario.terminal!.kill) {
            await context.client.request(methods.client.terminal.kill, {
              sessionId: context.params.sessionId,
              terminalId: created.terminalId,
            });
          }
          const exit = await context.client.request(methods.client.terminal.waitForExit, {
            sessionId: context.params.sessionId,
            terminalId: created.terminalId,
          });
          const output = await context.client.request(methods.client.terminal.output, {
            sessionId: context.params.sessionId,
            terminalId: created.terminalId,
          });
          observe({
            method: "terminal",
            output: output.output,
            truncated: output.truncated,
            exitCode: exit.exitCode,
          });
          await context.client.request(methods.client.terminal.release, {
            sessionId: context.params.sessionId,
            terminalId: created.terminalId,
          });
        });
      }
      if (scenario.elicitation !== undefined) {
        turn = turn.then(async () => {
          const response = await context.client.request(
            methods.client.elicitation.create,
            scenario.elicitation === "form"
              ? {
                  mode: "form",
                  sessionId: context.params.sessionId,
                  message: "Scripted form",
                  requestedSchema: {
                    type: "object",
                    properties: { answer: { type: "string" } },
                  },
                }
              : {
                  mode: "url",
                  sessionId: context.params.sessionId,
                  message: "Scripted URL",
                  elicitationId: "scripted-elicitation",
                  url: "https://example.invalid/auth",
                },
          );
          observe({
            method: "elicitation/create",
            mode: scenario.elicitation!,
            action: response.action,
          });
          if (scenario.elicitation !== "url") return;
          await context.client.notify(methods.client.elicitation.complete, {
            elicitationId: "scripted-elicitation",
          });
          observe({
            method: "elicitation/complete",
            elicitationId: "scripted-elicitation",
          });
        });
      }

      const waitForCancel = scenario.waitForCancel || scenario.requestPermission;
      if (waitForCancel) turn = turn.then(() => cancellation);
      return turn
        .then(() => sendAll(context.client, context.params.sessionId, scenario.afterCancel))
        .then(() => {
          phase = "session";
          return {
            stopReason: waitForCancel ? "cancelled" : scenario.stopReason,
          } satisfies PromptResponse;
        });
    })
    .onNotification(methods.agent.session.cancel, (context) => {
      if (phase !== "prompting") return;
      observe({ method: "session/cancel", sessionId: context.params.sessionId });
      cancellationEvents.emit("cancel");
    });

  application.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
};

runScriptedAcpAgent();
