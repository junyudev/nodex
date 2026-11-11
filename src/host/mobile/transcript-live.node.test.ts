import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { NODEX_COORDINATOR_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/nodex-coordinator";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { ProjectSession } from "../../shared/types";
import {
  AgentRuntimeApplication,
  make as makeApplication,
} from "../../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../../main/agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSupervisor } from "../../main/agent-runtime/AgentRuntimeSupervisor";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { ProjectRuntimeLifecycleRuntime } from "../../main/host-runtime/ProjectRuntimeLifecycleRuntime";
import { acquireAgentRuntimeProcess } from "../../main/platform/node/AgentRuntimeProcess";
import { ProjectWorkspace } from "../../main/project-application/ProjectWorkspace";
import { HostInvocation } from "../HostInvocation";
import { PhoneRequests } from "./PhoneRequests";
import { UserPresence } from "../UserPresence";
import { testLayer } from "../../main/app/MainConfig";
import { makeMobileTranscript as makeTranscriptOnHost } from "./transcript";

/** This host writes paths the way a POSIX test machine does. */
const makeMobileTranscript = (chats: Parameters<typeof makeTranscriptOnHost>[0]) =>
  makeTranscriptOnHost(chats).pipe(Effect.provide(testLayer()));

const PROMPT = "Follow this Run from the phone";
const fixturePath = (name: string) =>
  fileURLToPath(new URL(`../../../tests/e2e/fixtures/${name}`, import.meta.url));

const acquireScenario = Effect.acquireRelease(
  Effect.callback<
    { scenario: CoreScenarioContext; release: () => void; completed: Promise<void> },
    unknown
  >((resume) => {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = withCoreScenario(
      { scenarioId: NODEX_COORDINATOR_SCENARIO_ID },
      async (scenario) => {
        resume(Effect.succeed({ scenario, release, completed }));
        await released;
      },
    );
    void completed.catch((cause) => resume(Effect.fail(cause)));
  }),
  ({ release, completed }) =>
    Effect.promise(() => {
      release();
      return completed;
    }),
);

it.live(
  "a phone that opens a chat while its Run works catches up and then follows the Run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { scenario } = yield* acquireScenario;
        const home = join(scenario.profile.nodexHome, "execution");
        const fake = join(home, "fake-codex");
        const commands = join(fake, "commands.jsonl");
        yield* Effect.promise(async () => {
          await mkdir(fake, { recursive: true });
          await writeFile(
            join(fake, "state.json"),
            JSON.stringify({
              thread: null,
              turns: [],
              turnSequence: 0,
              queueSequence: 0,
              queuedSubmissions: [],
            }),
          );
          await writeFile(commands, "");
          const peer = pathToFileURL(fixturePath("codex-transcript-performance-app-server.mjs"));
          await writeFile(join(home, "app-server"), `void import(${JSON.stringify(peer.href)});\n`);
        });
        const command = (value: object) =>
          Effect.promise(() => appendFile(commands, `${JSON.stringify(value)}\n`));
        const runtime = yield* acquireAgentRuntimeProcess({
          executable: process.execPath,
          entryPath: fileURLToPath(
            new URL("../../../packages/agent-runtime/src/nodex/entry.ts", import.meta.url),
          ),
          environment: {
            ...process.env,
            NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}`,
            NODEX_FAKE_CODEX_STATE_PATH: join(fake, "state.json"),
            NODEX_FAKE_CODEX_COMMAND_PATH: commands,
            NODEX_FAKE_CODEX_LOG_PATH: join(fake, "requests.jsonl"),
            NODEX_FAKE_CODEX_BASE_FIXTURE: fixturePath("codex-queue-app-server.mjs"),
            NODEX_FAKE_CODEX_CONTROLLED_PROMPT: PROMPT,
          },
          configuration: {
            home,
            cwd: home,
            automaticWorkAtOnce: 2,
            host: { tools: [] },
            providers: {
              codex: {
                driver: "codex",
                config: {
                  binaryPath: process.execPath,
                  homePath: join(home, "codex"),
                  setupMode: "existing",
                },
              },
            },
          },
          host: () => Effect.succeed({}),
        });
        const core = {
          workspace: {
            apply: (input: Parameters<CoreModules["Service"]["workspace"]["apply"]>[0]) =>
              Effect.tryPromise(() => scenario.client.workspaceApply(input)),
            read: (input: Parameters<CoreModules["Service"]["workspace"]["read"]>[0]) =>
              Effect.tryPromise(() => scenario.client.workspaceRead(input)),
          },
        };
        const application = yield* makeApplication({
          connect: Effect.succeed(runtime),
          currentConnection: Effect.succeed(runtime),
          projectless: {
            engineProjectId: "profile:projectless",
            workspaceRoot: home,
            ensureWorkspaceRoot: Effect.void,
          },
        }).pipe(
          Effect.provideService(CoreModules, core as never),
          Effect.provideService(ProjectWorkspace, {} as never),
          Effect.provideService(ProjectRuntimeLifecycleRuntime, {
            runExclusive: (_id, use) => use,
          }),
        );

        const projectId = scenario.manifest.projectId;
        const sessionId = createUuidV7();
        const threadId = `thread:${sessionId}`;
        const cwd = join(home, "chat");
        yield* Effect.promise(() => mkdir(cwd, { recursive: true }));
        yield* Effect.promise(() =>
          scenario.client.workspaceApply({
            operationId: createUuidV7(),
            intent: {
              kind: "create_agent_runtime_session",
              session_id: sessionId,
              project_id: projectId,
              runtime_id: runtime.identity.runtimeId,
              runtime_thread_id: threadId,
              launch_request_id: `launch:${sessionId}`,
              title: "Phone follow",
              initial_page_ids: [],
            },
          }),
        );
        yield* runtime.request("command.dispatch", {
          command: {
            type: "thread.create",
            commandId: `create:${threadId}`,
            threadId,
            projectId,
            title: "Phone follow",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "system",
            creationSource: "server",
          },
        });
        yield* runtime.request("thread.send", {
          threadId,
          commandId: `send:${threadId}`,
          messageId: createUuidV7(),
          text: PROMPT,
          attachments: [],
          mode: "auto",
          createdBy: "system",
        });
        const message = (id: string, text: string) => ({
          type: "item",
          item: {
            type: "agentMessage",
            id,
            text,
            phase: "commentary",
            delivery: null,
            memoryCitation: null,
            questions: null,
          },
        });
        const texts = Effect.gen(function* () {
          const { snapshot } = yield* application.read({ sessionId });
          return snapshot.projection.visibleTurnItems.flatMap(({ item }) =>
            item.type === "assistant_message" ? [item.text] : [],
          );
        });
        // The Run is working and has already said something when the phone arrives.
        yield* command(message("before", "Started before the phone opened"));
        yield* texts.pipe(
          Effect.repeat({
            until: (seen) => seen.includes("Started before the phone opened"),
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("45 seconds"),
        );

        const row = {
          id: sessionId,
          projectId: null,
          displayTitle: "Phone follow",
          archived: false,
          executionRef: { runtimeId: runtime.identity.runtimeId, threadId },
        } as unknown as ProjectSession;
        const pushed: { readonly event: string; readonly data: unknown }[] = [];
        const transcript = yield* makeMobileTranscript({
          session: () => Effect.succeed(row),
        }).pipe(
          Effect.provideService(AgentRuntimeApplication, application),
          Effect.provideService(AgentRuntimeSessionActivity, {
            read: Effect.succeed({ items: [] }),
            activityChanges: Stream.never,
          } as unknown as AgentRuntimeSessionActivity["Service"]),
          Effect.provideService(AgentRuntimeSupervisor, {
            get: () => Effect.succeed(runtime),
          } as unknown as AgentRuntimeSupervisor["Service"]),
          Effect.provideService(DatabaseNotifierRuntime, {
            projectSessionInvalidations: Stream.never,
          } as unknown as DatabaseNotifierRuntime["Service"]),
          Effect.provideService(ProjectWorkspace, {} as never),
          Effect.provideService(UserPresence, {
            showOnPhone: () => Effect.void,
          } as unknown as UserPresence["Service"]),
        );
        const entitlement = {
          filter: (_: string, requests: readonly unknown[]) => Effect.succeed(requests),
        };
        const phone = yield* transcript((event, data) =>
          Effect.sync(() => {
            pushed.push({ event, data });
          }),
        ).pipe(
          Effect.provideService(HostInvocation, "observation-proof"),
          Effect.provideService(PhoneRequests, entitlement as never),
        );
        const opened = yield* Effect.flatten(phone.handlers["chat.open"]({ sessionId })).pipe(
          Effect.provideService(HostInvocation, "request-proof"),
          Effect.provideService(PhoneRequests, entitlement as never),
        );
        expect(JSON.stringify(opened.items)).toContain("Started before the phone opened");

        // What the Run does after the phone opened reaches it without another open, including a
        // long command while it is still running.
        const loop = {
          type: "commandExecution",
          id: "loop",
          command: "for i in 1 2 3; do echo tick $i; sleep 1; done",
          cwd,
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        };
        yield* command({ type: "item", item: loop, completed: false });
        yield* Effect.sync(() => JSON.stringify(pushed)).pipe(
          Effect.repeat({
            until: (seen) => seen.includes("tick $i"),
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        yield* command(message("after", "Said after the phone opened"));
        yield* Effect.sync(() => JSON.stringify(pushed)).pipe(
          Effect.repeat({
            until: (seen) => seen.includes("Said after the phone opened"),
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        yield* command({ type: "complete" });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  120_000,
);
