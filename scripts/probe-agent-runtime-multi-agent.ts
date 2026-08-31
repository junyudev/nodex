import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import { ScopedCallbackRuntime } from "../src/main/app/ScopedCallbackRuntime";
import { resolveCodexRuntime } from "../src/main/codex/codex-runtime";
import {
  type CodexProbeClient,
  runCodexProbeMain,
  withCodexProbeSession,
} from "./codex-probe-session";
import {
  responses as modelResponses,
  type ScriptedModelHttpResponse,
  type ScriptedModelRequest,
  ScriptedModelServer,
} from "./scenarios/runtime/scripted-model-server";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const requestTimeoutMs = 60_000;
const namespace = "collaboration";
const rootFlowMarker = "NODEX_SEMANTIC_FLOW_ROOT";
const alphaInitialMarker = "NODEX_SEMANTIC_ALPHA_INITIAL";
const alphaPingMarker = "NODEX_SEMANTIC_ALPHA_PING";
const alphaReloadMarker = "NODEX_SEMANTIC_ALPHA_RELOAD";
const alphaInterruptMarker = "NODEX_SEMANTIC_ALPHA_INTERRUPT";
const alphaReuseMarker = "NODEX_SEMANTIC_ALPHA_REUSE";
const betaInitialMarker = "NODEX_SEMANTIC_BETA_INITIAL";
const betaReloadMarker = "NODEX_SEMANTIC_BETA_RELOAD";
const gammaInitialMarker = "NODEX_SEMANTIC_GAMMA_INITIAL";

type JsonRecord = Record<string, unknown>;

type IncomingMessage = Pick<ScriptedModelRequest, "body" | "onAbort" | "signal">;

class SemanticModelResponse {
  readonly #request: IncomingMessage;
  #response: ScriptedModelHttpResponse | null = null;

  constructor(request: IncomingMessage) {
    this.#request = request;
  }

  get destroyed(): boolean {
    return this.#request.signal.aborted;
  }

  once(event: "close", listener: () => void): void {
    if (event === "close") this.#request.onAbort(listener);
  }

  send(response: ScriptedModelHttpResponse): void {
    if (this.#response) throw new Error("Semantic model scenario attempted to respond twice");
    this.#response = response;
  }

  take(): ScriptedModelHttpResponse {
    if (this.#response) return this.#response;
    if (this.destroyed) return { chunks: [], keepOpen: true };
    throw new Error("Semantic model scenario completed without a response");
  }
}

type ServerResponse = SemanticModelResponse;

type SemanticState = {
  alphaCompleted: boolean;
  alphaInterruptRequestAborted: boolean;
  alphaInterruptRequestStarted: boolean;
  alphaPingObserved: boolean;
  betaCompleted: boolean;
  betaEvictedObserved: boolean;
  betaReloadObserved: boolean;
  diagnosticFailures: string[];
  flowPhase: number;
  gammaCompleted: boolean;
  nestedDirectParentEnvelopeObserved: boolean;
  strict: boolean;
};

type ConformanceStatus = "pass" | "fail";

export type AgentRuntimeMultiAgentConformanceReport = {
  readonly binaryPath: string;
  readonly capabilities: {
    readonly cleanup: ConformanceStatus;
    readonly completionDeliveryAndNestedDirectParent: ConformanceStatus;
    readonly followupAfterInterruptReuse: ConformanceStatus;
    readonly interruptListAndWait: ConformanceStatus;
    readonly residencyEvictionAndReload: ConformanceStatus;
    readonly sendMessage: ConformanceStatus;
    readonly spawnSuccess: ConformanceStatus;
  };
  readonly diagnosticFailures: readonly string[];
  readonly generatedAt: string;
  readonly observedSubagentActivityEvents: number;
};

function requireConformance(state: SemanticState, condition: boolean, message: string): boolean {
  if (condition) return true;
  if (state.strict) throw new Error(message);
  state.diagnosticFailures.push(message);
  return false;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  return request.body;
}

function inputItems(body: JsonRecord): readonly unknown[] {
  return Array.isArray(body.input) ? body.input : [];
}

function inputContains(body: JsonRecord, marker: string): boolean {
  return JSON.stringify(inputItems(body)).includes(marker);
}

function hasAgentMessage(body: JsonRecord, marker: string): boolean {
  return inputItems(body).some(
    (item) =>
      isRecord(item) && item.type === "agent_message" && JSON.stringify(item).includes(marker),
  );
}

function functionOutput(body: JsonRecord, callId: string): string | null {
  const item = inputItems(body).find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.type === "function_call_output" &&
      candidate.call_id === callId,
  );
  return item ? JSON.stringify(item) : null;
}

function requireFunctionOutput(body: JsonRecord, callId: string): string {
  const output = functionOutput(body, callId);
  if (output) return output;
  throw new Error(`Semantic probe did not receive function output for ${callId}`);
}

function sendResponsesEvents(response: ServerResponse, events: readonly JsonRecord[]): void {
  response.send(modelResponses.stream(events));
}

function created(responseId: string): JsonRecord {
  return { type: "response.created", response: { id: responseId } };
}

function completed(responseId: string): JsonRecord {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  };
}

function toolCall(callId: string, name: string, arguments_: JsonRecord): JsonRecord {
  return {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: callId,
      namespace,
      name,
      arguments: JSON.stringify(arguments_),
    },
  };
}

function assistantMessage(text: string): JsonRecord {
  return {
    type: "response.output_item.done",
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  };
}

function respondWithTool(
  response: ServerResponse,
  responseId: string,
  callId: string,
  name: string,
  arguments_: JsonRecord,
): void {
  sendResponsesEvents(response, [
    created(responseId),
    toolCall(callId, name, arguments_),
    completed(responseId),
  ]);
}

function respondWithText(response: ServerResponse, responseId: string, text: string): void {
  sendResponsesEvents(response, [
    created(responseId),
    assistantMessage(text),
    completed(responseId),
  ]);
}

function statusFromListOutput(output: string, taskPath: string): string | null {
  const item = JSON.parse(output) as unknown;
  if (!isRecord(item) || typeof item.output !== "string") return null;
  const payload = JSON.parse(item.output) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.agents)) return null;
  const agent = payload.agents.find(
    (candidate) => isRecord(candidate) && candidate.agent_name === taskPath,
  );
  if (!isRecord(agent)) return null;
  if (typeof agent.agent_status === "string") return agent.agent_status;
  if (!isRecord(agent.agent_status)) return null;
  if (typeof agent.agent_status.completed === "string") return "completed";
  return null;
}

function listOrWaitForStatus(input: {
  body: JsonRecord;
  expectedStatus: string;
  listCallId: string;
  response: ServerResponse;
  responseId: string;
  state: SemanticState;
  taskPath: string;
  waitCallId: string;
}): boolean {
  const output = requireFunctionOutput(input.body, input.listCallId);
  const status = statusFromListOutput(output, input.taskPath);
  if (status === input.expectedStatus) return true;
  if (!status) throw new Error(`list_agents omitted ${input.taskPath}: ${output}`);
  respondWithTool(input.response, input.responseId, input.waitCallId, "wait_agent", {
    timeout_ms: 5_000,
  });
  input.state.flowPhase -= 1;
  return false;
}

async function waitForSemanticCondition(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function handleFlowRoot(
  body: JsonRecord,
  response: ServerResponse,
  state: SemanticState,
): Promise<void> {
  switch (state.flowPhase) {
    case 0:
      state.flowPhase = 1;
      respondWithTool(response, "flow-spawn-alpha", "flow_spawn_alpha", "spawn_agent", {
        task_name: "alpha",
        fork_turns: "none",
        message: alphaInitialMarker,
      });
      return;
    case 1: {
      const output = requireFunctionOutput(body, "flow_spawn_alpha");
      if (!output.includes("/root/alpha")) throw new Error(`Alpha spawn failed: ${output}`);
      state.flowPhase = 2;
      respondWithTool(response, "flow-send", "flow_send", "send_message", {
        target: "/root/alpha",
        message: alphaPingMarker,
      });
      return;
    }
    case 2:
      requireFunctionOutput(body, "flow_send");
      state.flowPhase = 3;
      respondWithTool(response, "flow-wait-alpha", "flow_wait_alpha", "wait_agent", {
        timeout_ms: 5_000,
      });
      return;
    case 3:
      requireFunctionOutput(body, "flow_wait_alpha");
      state.flowPhase = 4;
      respondWithTool(response, "flow-list-alpha", "flow_list_alpha", "list_agents", {});
      return;
    case 4:
      if (
        !listOrWaitForStatus({
          body,
          expectedStatus: "completed",
          listCallId: "flow_list_alpha",
          response,
          responseId: "flow-rewait-alpha",
          state,
          taskPath: "/root/alpha",
          waitCallId: "flow_wait_alpha",
        })
      ) {
        return;
      }
      state.alphaCompleted = true;
      state.flowPhase = 5;
      respondWithTool(response, "flow-touch-alpha", "flow_touch_alpha", "send_message", {
        target: "/root/alpha",
        message: "NODEX_SEMANTIC_ALPHA_RESIDENCY_TOUCH",
      });
      return;
    case 5:
      requireFunctionOutput(body, "flow_touch_alpha");
      state.flowPhase = 6;
      respondWithTool(response, "flow-spawn-gamma", "flow_spawn_gamma", "spawn_agent", {
        task_name: "gamma",
        fork_turns: "none",
        message: gammaInitialMarker,
      });
      return;
    case 6:
      requireFunctionOutput(body, "flow_spawn_gamma");
      state.flowPhase = 7;
      respondWithTool(response, "flow-wait-gamma", "flow_wait_gamma", "wait_agent", {
        timeout_ms: 5_000,
      });
      return;
    case 7:
      requireFunctionOutput(body, "flow_wait_gamma");
      state.flowPhase = 8;
      respondWithTool(response, "flow-list-gamma", "flow_list_gamma", "list_agents", {});
      return;
    case 8:
      if (
        !listOrWaitForStatus({
          body,
          expectedStatus: "completed",
          listCallId: "flow_list_gamma",
          response,
          responseId: "flow-rewait-gamma",
          state,
          taskPath: "/root/gamma",
          waitCallId: "flow_wait_gamma",
        })
      ) {
        return;
      }
      state.gammaCompleted = true;
      if (
        statusFromListOutput(requireFunctionOutput(body, "flow_list_gamma"), "/root/alpha/beta")
      ) {
        throw new Error("Residency pressure did not evict the oldest completed nested agent");
      }
      state.betaEvictedObserved = true;
      state.flowPhase = 9;
      respondWithTool(response, "flow-followup-reload", "flow_followup_reload", "followup_task", {
        target: "/root/alpha",
        message: alphaReloadMarker,
      });
      return;
    case 9:
      requireFunctionOutput(body, "flow_followup_reload");
      state.flowPhase = 10;
      respondWithTool(response, "flow-wait-reload", "flow_wait_reload", "wait_agent", {
        timeout_ms: 5_000,
      });
      return;
    case 10:
      requireFunctionOutput(body, "flow_wait_reload");
      state.flowPhase = 11;
      respondWithTool(response, "flow-list-reload", "flow_list_reload", "list_agents", {});
      return;
    case 11:
      if (
        !listOrWaitForStatus({
          body,
          expectedStatus: "completed",
          listCallId: "flow_list_reload",
          response,
          responseId: "flow-rewait-reload",
          state,
          taskPath: "/root/alpha",
          waitCallId: "flow_wait_reload",
        })
      ) {
        return;
      }
      state.flowPhase = 12;
      respondWithTool(
        response,
        "flow-followup-interrupt",
        "flow_followup_interrupt",
        "followup_task",
        {
          target: "/root/alpha",
          message: alphaInterruptMarker,
        },
      );
      return;
    case 12:
      requireFunctionOutput(body, "flow_followup_interrupt");
      // The scenario proves cancellation of an in-flight provider request, not merely
      // cancellation while the follow-up is still queued. Fast hosts can otherwise
      // return the accepted follow-up receipt and issue the interrupt before the
      // child reaches this mock server.
      await waitForSemanticCondition(
        () => state.alphaInterruptRequestStarted,
        "the interrupt target's provider request to start",
      );
      state.flowPhase = 13;
      respondWithTool(response, "flow-interrupt", "flow_interrupt", "interrupt_agent", {
        target: "/root/alpha",
      });
      return;
    case 13:
      requireFunctionOutput(body, "flow_interrupt");
      state.flowPhase = 14;
      respondWithTool(
        response,
        "flow-list-interrupted",
        "flow_list_interrupted",
        "list_agents",
        {},
      );
      return;
    case 14: {
      const output = requireFunctionOutput(body, "flow_list_interrupted");
      const status = statusFromListOutput(output, "/root/alpha");
      if (status !== "interrupted") {
        throw new Error(`Interrupted alpha was not resident and listed as interrupted: ${output}`);
      }
      state.flowPhase = 15;
      respondWithTool(response, "flow-followup-reuse", "flow_followup_reuse", "followup_task", {
        target: "/root/alpha",
        message: alphaReuseMarker,
      });
      return;
    }
    case 15:
      requireFunctionOutput(body, "flow_followup_reuse");
      state.flowPhase = 16;
      respondWithTool(response, "flow-wait-reuse", "flow_wait_reuse", "wait_agent", {
        timeout_ms: 5_000,
      });
      return;
    case 16:
      requireFunctionOutput(body, "flow_wait_reuse");
      state.flowPhase = 17;
      respondWithTool(response, "flow-list-final", "flow_list_final", "list_agents", {});
      return;
    default: {
      if (
        !listOrWaitForStatus({
          body,
          expectedStatus: "completed",
          listCallId: "flow_list_final",
          response,
          responseId: "flow-rewait-reuse",
          state,
          taskPath: "/root/alpha",
          waitCallId: "flow_wait_reuse",
        })
      ) {
        return;
      }
      state.flowPhase = 18;
      respondWithText(response, "flow-finished", "multi-agent semantic conformance complete");
    }
  }
}

async function handleSemanticRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: SemanticState,
): Promise<void> {
  const body = await readJsonBody(request);
  if (hasAgentMessage(body, gammaInitialMarker)) {
    state.gammaCompleted = true;
    respondWithText(response, "gamma-child", "gamma complete");
    return;
  }
  if (hasAgentMessage(body, betaReloadMarker)) {
    state.betaReloadObserved = true;
    respondWithText(response, "beta-reload", "beta reload complete");
    return;
  }
  if (hasAgentMessage(body, betaInitialMarker)) {
    state.betaCompleted = true;
    await new Promise((resolve) => setTimeout(resolve, 250));
    respondWithText(response, "beta-child", "beta initial complete");
    return;
  }
  if (hasAgentMessage(body, alphaReuseMarker)) {
    respondWithText(response, "alpha-reuse", "alpha reuse complete");
    return;
  }
  if (hasAgentMessage(body, alphaInterruptMarker)) {
    state.alphaInterruptRequestStarted = true;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 10_000);
      const aborted = (): void => {
        clearTimeout(timeout);
        state.alphaInterruptRequestAborted = true;
        resolve();
      };
      request.onAbort(aborted);
      response.once("close", aborted);
    });
    if (!state.alphaInterruptRequestAborted && !response.destroyed) {
      respondWithText(response, "alpha-interrupt-timeout", "interrupt did not arrive");
    }
    return;
  }
  if (hasAgentMessage(body, alphaReloadMarker)) {
    if (!functionOutput(body, "alpha_reload_beta")) {
      respondWithTool(response, "alpha-reload-beta", "alpha_reload_beta", "followup_task", {
        target: "/root/alpha/beta",
        message: betaReloadMarker,
      });
      return;
    }
    requireFunctionOutput(body, "alpha_reload_beta");
    respondWithText(response, "alpha-reload", "alpha reload complete");
    return;
  }
  if (hasAgentMessage(body, alphaInitialMarker)) {
    const spawnOutput = functionOutput(body, "alpha_spawn_beta");
    if (!spawnOutput) {
      // Give app-server time to install its watch for the just-spawned alpha thread before
      // alpha emits nested activity. This mirrors the desktop's asynchronous discovery path.
      await new Promise((resolve) => setTimeout(resolve, 250));
      respondWithTool(response, "alpha-spawn-beta", "alpha_spawn_beta", "spawn_agent", {
        task_name: "beta",
        fork_turns: "none",
        message: betaInitialMarker,
      });
      return;
    }
    if (!spawnOutput.includes("/root/alpha/beta")) {
      throw new Error(`Nested beta spawn failed: ${spawnOutput}`);
    }
    if (!functionOutput(body, "alpha_wait_beta")) {
      state.alphaPingObserved = inputContains(body, alphaPingMarker);
      respondWithTool(response, "alpha-wait-beta", "alpha_wait_beta", "wait_agent", {
        timeout_ms: 5_000,
      });
      return;
    }
    const serializedInput = JSON.stringify(inputItems(body));
    state.nestedDirectParentEnvelopeObserved =
      serializedInput.includes("/root/alpha/beta") &&
      /Message Type: (?:FINAL_ANSWER|COMPLETED)|completed/iu.test(serializedInput);
    state.alphaCompleted = true;
    respondWithText(response, "alpha-child", "alpha initial complete");
    return;
  }
  if (inputContains(body, rootFlowMarker)) {
    await handleFlowRoot(body, response, state);
    return;
  }
  throw new Error(
    `Semantic mock received an unclassified request: ${JSON.stringify(body).slice(0, 1_000)}`,
  );
}

async function startSemanticServer(state: SemanticState): Promise<ScriptedModelServer> {
  return await ScriptedModelServer.start({
    exchanges: [
      {
        name: "multi-agent semantic scenario",
        expectedCalls: 1,
        maximumCalls: Number.POSITIVE_INFINITY,
        match: (request) => request.path.endsWith("/responses"),
        respond: async (request) => {
          const response = new SemanticModelResponse(request);
          await handleSemanticRequest(request, response, state);
          return response.take();
        },
      },
    ],
  });
}

function waitForTurnCompletion(client: CodexProbeClient, threadId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for semantic turn on ${threadId}`));
    }, requestTimeoutMs);
    const listener = (notification: ServerNotification): void => {
      if (notification.method !== "turn/completed") return;
      const params: unknown = notification.params;
      if (!isRecord(params) || params.threadId !== threadId) return;
      cleanup();
      const turn = isRecord(params.turn) ? params.turn : {};
      if (turn.status !== "completed") {
        reject(new Error(`Semantic turn failed: ${JSON.stringify(turn.error ?? turn)}`));
        return;
      }
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      client.off("notification", listener);
    };
    client.on("notification", listener);
  });
}

async function probeMultiAgentPromise(
  input: {
    readonly binaryPath: string;
    readonly mode?: "diagnostic" | "strict";
    readonly outputPath?: string;
  },
  callbacks: ScopedCallbackRuntime["Service"],
): Promise<AgentRuntimeMultiAgentConformanceReport> {
  const state: SemanticState = {
    alphaCompleted: false,
    alphaInterruptRequestAborted: false,
    alphaInterruptRequestStarted: false,
    alphaPingObserved: false,
    betaCompleted: false,
    betaEvictedObserved: false,
    betaReloadObserved: false,
    diagnosticFailures: [],
    flowPhase: 0,
    gammaCompleted: false,
    nestedDirectParentEnvelopeObserved: false,
    strict: input.mode !== "diagnostic",
  };
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-agent-runtime-semantic-"));
  const stateHome = path.join(temporaryRoot, "home");
  const cwd = path.join(temporaryRoot, "workspace");
  mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const server = await startSemanticServer(state);
  let observedSubagentActivityEvents = 0;
  try {
    await callbacks.runPromise(
      withCodexProbeSession(
        callbacks,
        {
          binaryPath: input.binaryPath,
          requestTimeout: requestTimeoutMs,
          expectedCodexHome: stateHome,
          env: {
            ...process.env,
            ...server.loopbackEnvironment(),
            CODEX_HOME: stateHome,
            NODEX_SEMANTIC_API_KEY: "nodex-semantic-secret",
          },
          clientInfo: {
            name: "nodex-agent-runtime-semantic-conformance",
            title: "Nodex Agent Runtime Semantic Conformance",
            version: "1.0.0",
          },
        },
        async (client) => {
          const listener = (notification: ServerNotification): void => {
            const params: unknown = notification.params;
            const item = isRecord(params) && isRecord(params.item) ? params.item : null;
            if (item?.type === "subAgentActivity") {
              observedSubagentActivityEvents += 1;
            }
          };
          client.on("notification", listener);
          try {
            const providerId = "nodex-semantic-provider";
            const providerConfig = {
              name: providerId,
              base_url: `${server.baseUrl}/v1`,
              env_key: "NODEX_SEMANTIC_API_KEY",
              wire_api: "responses",
              request_max_retries: 0,
              stream_max_retries: 0,
            };
            const config = {
              [`model_providers.${providerId}`]: providerConfig,
              "features.plugins": false,
              "features.code_mode": false,
              "features.code_mode_only": false,
              "agents.enabled": true,
              "features.multi_agent_v2": {
                enabled: true,
                max_concurrent_threads_per_session: 3,
                min_wait_timeout_ms: 0,
                default_wait_timeout_ms: 5_000,
                max_wait_timeout_ms: 5_000,
                tool_namespace: namespace,
                expose_spawn_agent_model_overrides: true,
                wait_agent_enabled: true,
                non_code_mode_only: false,
              },
            };
            const run = async (marker: string): Promise<void> => {
              const thread = await client.request("thread/start", {
                ephemeral: false,
                model: "gpt-5.6-sol",
                modelProvider: providerId,
                cwd,
                approvalPolicy: "never",
                sandbox: "danger-full-access",
                config,
              });
              if (
                !isRecord(thread) ||
                !isRecord(thread.thread) ||
                typeof thread.thread.id !== "string"
              ) {
                throw new Error("Semantic probe received an invalid thread/start response");
              }
              const completion = waitForTurnCompletion(client, thread.thread.id);
              await client.request("turn/start", {
                threadId: thread.thread.id,
                input: [{ type: "text", text: marker, text_elements: [] }],
              });
              await completion;
            };
            await run(rootFlowMarker);
          } finally {
            client.off("notification", listener);
          }
        },
      ),
    );
    requireConformance(
      state,
      state.flowPhase === 18 &&
        state.alphaCompleted &&
        state.alphaPingObserved &&
        state.betaCompleted &&
        state.betaEvictedObserved &&
        state.betaReloadObserved &&
        state.gammaCompleted &&
        state.nestedDirectParentEnvelopeObserved &&
        state.alphaInterruptRequestStarted &&
        state.alphaInterruptRequestAborted,
      `Multi-agent semantic scenario was incomplete: ${JSON.stringify(state)}`,
    );
    const report: AgentRuntimeMultiAgentConformanceReport = {
      binaryPath: path.resolve(input.binaryPath),
      capabilities: {
        cleanup: "pass",
        completionDeliveryAndNestedDirectParent: "pass",
        followupAfterInterruptReuse: "pass",
        interruptListAndWait: "pass",
        residencyEvictionAndReload: "pass",
        sendMessage: "pass",
        spawnSuccess: "pass",
      },
      diagnosticFailures: state.diagnosticFailures,
      generatedAt: new Date().toISOString(),
      observedSubagentActivityEvents,
    };
    if (input.outputPath) {
      mkdirSync(path.dirname(input.outputPath), { recursive: true });
      writeFileSync(input.outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    }
    server.verify();
    return report;
  } catch (error) {
    const transcript = server.transcript();
    const operationFailure = new Error(
      `${error instanceof Error ? error.message : String(error)}${transcript ? `\n\nScripted model transcript:\n${transcript}` : ""}`,
      { cause: error },
    );
    try {
      server.verify();
    } catch (verificationFailure) {
      const combinedFailure = new AggregateError(
        [operationFailure, verificationFailure],
        `Multi-agent semantic conformance failed:\n${operationFailure.message}\n\n${verificationFailure instanceof Error ? verificationFailure.message : String(verificationFailure)}`,
      );
      combinedFailure.cause = verificationFailure;
      throw combinedFailure;
    }
    throw operationFailure;
  } finally {
    await server.close();
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

export const probeAgentRuntimeMultiAgent = (input: {
  readonly binaryPath: string;
  readonly mode?: "diagnostic" | "strict";
  readonly outputPath?: string;
}): Effect.Effect<
  AgentRuntimeMultiAgentConformanceReport,
  Cause.UnknownError,
  ScopedCallbackRuntime
> =>
  Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    return yield* Effect.tryPromise(() => probeMultiAgentPromise(input, callbacks));
  });

function readOption(argv: string[], option: string): string | null {
  const index = argv.indexOf(option);
  if (index < 0) return null;
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
}

const main = Effect.gen(function* () {
  const argv = process.argv.slice(2);
  const explicitBinaryPath = readOption(argv, "--binary");
  const binaryPath = path.resolve(
    explicitBinaryPath ??
      resolveCodexRuntime({ isPackaged: false, projectRootPath: projectRoot }).binaryPath,
  );
  const outputPath = path.resolve(
    readOption(argv, "--out") ??
      path.join(projectRoot, ".generated", "agent-runtime-conformance", "multi-agent.json"),
  );
  const report = yield* probeAgentRuntimeMultiAgent({
    binaryPath,
    mode: argv.includes("--diagnostic") ? "diagnostic" : "strict",
    outputPath,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCodexProbeMain(main);
}
