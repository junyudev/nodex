import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CodexPersonality } from "../../../shared/types";
import { MainConfig } from "../../app/MainConfig";
import { CodexAccount } from "../../codex-application/CodexAccount";
import { CodexConnection } from "../../codex-application/CodexConnection";
import { CodexMedia } from "../../codex-application/CodexMedia";
import { emptyAccountSnapshot } from "../../codex-application/CodexAccountState";
import { CodexToolRuntime } from "../../codex-application/CodexToolRuntime";
import { ComposerCatalog } from "../../codex-application/ComposerCatalog";
import { ComposerExternalSuggestions } from "../../codex-application/ComposerExternalSuggestions";
import { ConversationCommands } from "../../codex-application/ConversationCommands";
import { CodexPreferences } from "../../codex-application/CodexPreferences";
import { CodexAttachments } from "../../codex-application/CodexAttachments";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { live } from "./CodexApplicationIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, Error>;

it.effect("registers application channels directly against their owning modules", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.sync(() => {
          handlers.set(channel, handler as Handler);
        }),
      on: () => Effect.void,
    });
    const accountSnapshot = yield* SubscriptionRef.make(emptyAccountSnapshot());
    const account = CodexAccount.of({
      snapshot: accountSnapshot,
      refresh: Effect.succeed(emptyAccountSnapshot()),
      consumeRateLimitResetCredit: () => Effect.die("unused"),
      startLogin: () => Effect.die("unused"),
      cancelLogin: () => Effect.die("unused"),
      logout: Effect.succeed(true),
    });
    const composer = ComposerCatalog.of({
      listModels: Effect.succeed([
        {
          id: "model-a",
          model: "model-a",
          displayName: "Model A",
          description: "",
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: "medium",
          inputModalities: ["text", "image"],
          multiAgentVersion: null,
          serviceTiers: [],
          defaultServiceTier: null,
          isDefault: true,
        },
      ]),
      listExperimentalFeatures: Effect.succeed([]),
      listCollaborationModes: Effect.succeed([]),
      listPlugins: () => Effect.succeed([]),
      activatePlugin: () => Effect.void,
      listSkills: () => Effect.succeed([]),
      listHooks: () => Effect.succeed({ data: [] }),
      updateHooksState: () => Effect.void,
    });
    const tools = CodexToolRuntime.of({
      readResource: () => Effect.die("unused"),
      callTool: () => Effect.die("unused"),
      listApps: Effect.succeed([]),
      listServerStatuses: () => Effect.die("unused"),
    });
    const externalSuggestions = ComposerExternalSuggestions.of({
      listSites: Effect.succeed({ available: false, sites: [] }),
      listChatGptConversations: () => Effect.succeed({ available: false, conversations: [] }),
    });
    const connection = CodexConnection.of({
      read: Effect.succeed({ status: "connected", retries: 0 }),
      changes: Stream.succeed({ status: "connected", retries: 0 }),
    });
    const media = CodexMedia.of({
      dictationState: Effect.succeed({
        isEnabled: true,
        authMethod: "chatgpt",
        shortcutLabel: "Ctrl+M",
        capabilities: {
          composer: true,
          global: true,
          history: true,
          streaming: "unknown",
          semanticCleanup: false,
          microphoneOwner: "none",
          auth: "chatgpt",
        },
      }),
      transcribe: () => Effect.succeed("hello"),
      cleanupTranscript: (input) => Effect.succeed(input.transcript),
      prepareStreamingConnectInfo: Effect.die("unused"),
      resolveImage: () => Effect.succeed({ ok: false, message: "not available", status: null }),
    });
    const reviewResponse = {
      reviewThreadId: "review-thread",
      turn: {
        id: "review-turn",
        items: [
          {
            type: "functionCallOutput",
            id: "review-function-output",
            name: "external_lookup",
            namespace: null,
            output: "opaque model-context result",
          },
        ],
        status: "failed",
        error: {
          message: "Request needs a narrower scope",
          misalignment: {
            errorType: "scope",
            steer: { message: "Continue with the narrowed scope" },
          },
        },
      },
    } satisfies ClientRequestResponsesByMethod["review/start"];
    const conversations = ConversationCommands.of({
      archive: () => Effect.die("unused"),
      deleteArchived: () => Effect.die("unused"),
      unarchive: () => Effect.die("unused"),
      setMemoryMode: () => Effect.void,
      startReview: () => Effect.succeed(reviewResponse),
      uploadFeedback: () => Effect.void,
      listBackgroundTerminalsPage: () => Effect.die("unused"),
      listBackgroundTerminals: () =>
        Effect.succeed([
          {
            itemId: "item-a",
            processId: "process-a",
            command: "vp run dev",
            cwd: "/repo",
            osPid: null,
            cpuPercent: null,
            rssKb: null,
          },
        ]),
      terminateBackgroundTerminal: () => Effect.succeed(true),
      interrupt: () => Effect.succeed(true),
      cleanBackgroundTerminals: () => Effect.succeed(true),
      cleanBackgroundTerminalsSilently: () => Effect.succeed(true),
    });
    let personality: CodexPersonality = "friendly";
    const preferences = CodexPreferences.of({
      snapshot: yield* SubscriptionRef.make<CodexPersonality>(personality),
      current: () => personality,
      setPersonality: (next) =>
        Effect.sync(() => {
          personality = next;
        }),
    });
    const attachments = CodexAttachments.of({
      createPastedText: () => Effect.die("unused"),
      readPastedText: () => Effect.die("unused"),
      removePastedText: () => Effect.die("unused"),
      materializePastedText: () => Effect.die("unused"),
      cleanupGoalSources: () => Effect.die("unused"),
      materializeGoal: () => Effect.die("unused"),
      cleanupMaterializedGoal: () => Effect.void,
      readEditableObjective: () => Effect.die("unused"),
    });
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ElectronIpc, ipc),
            Layer.succeed(
              ElectronWindowHost,
              ElectronWindowHost.of({
                all: Effect.succeed([]),
                destroyAll: Effect.void,
                fromWebContents: () => Effect.succeed(null),
                onCreated: () => Effect.void,
              }),
            ),
            Layer.succeed(
              MainConfig,
              MainConfig.of({
                assistantStreamingDebug: false,
                appVersion: "test",
                arch: "arm64",
                argv: [],
                composerAppshotHelperPath: null,
                documentsPath: "/tmp/Documents",
                environment: {},
                environmentPath: null,
                homeDirectory: "/tmp",
                initialProjectsDirectory: null,
                isDefaultApp: false,
                isPackaged: false,
                nodexHome: "/tmp/nodex-test",
                profileSettingsPath: "/tmp/nodex-test/config.toml",
                platform: "darwin",
                profileId: "test",
                projectRootPath: "/repo",
                rendererUrl: "http://localhost:5173",
                resourcesPath: "/resources",
                runtimeBinaryPath: "/electron",
              }),
            ),
            Layer.succeed(CodexAccount, account),
            Layer.succeed(CodexConnection, connection),
            Layer.succeed(CodexMedia, media),
            Layer.succeed(ComposerCatalog, composer),
            Layer.succeed(ComposerExternalSuggestions, externalSuggestions),
            Layer.succeed(ConversationCommands, conversations),
            Layer.succeed(CodexPreferences, preferences),
            Layer.succeed(CodexAttachments, attachments),
            Layer.succeed(CodexToolRuntime, tools),
          ),
        ),
      ),
      scope,
    );

    assert.isTrue(handlers.has("codex:account:read"));
    assert.isTrue(handlers.has("codex:connection:status"));
    assert.isTrue(handlers.has("codex:personality:get"));
    assert.isTrue(handlers.has("codex:personality:set"));
    assert.isTrue(handlers.has("codex:thread:goal:materialize-draft"));
    assert.isTrue(handlers.has("codex:pasted-text:create"));
    assert.isTrue(handlers.has("codex:pasted-text:read"));
    assert.isTrue(handlers.has("codex:pasted-text:remove"));
    assert.isTrue(handlers.has("codex:thread:memory-mode:set"));
    assert.isTrue(handlers.has("codex:review:start"));
    assert.isTrue(handlers.has("codex:feedback:upload"));
    assert.isTrue(handlers.has("codex:turn:interrupt"));
    assert.isTrue(handlers.has("codex:thread:background-terminals:clean"));
    assert.isTrue(handlers.has("codex:thread:background-terminals:clean-silent"));
    assert.isTrue(handlers.has("codex:thread:background-terminals:list"));
    assert.isTrue(handlers.has("codex:thread:background-terminals:terminate"));
    assert.isTrue(handlers.has("codex:conversation-image-asset:resolve"));
    assert.isTrue(handlers.has("codex:experimental-features:list"));
    assert.isTrue(handlers.has("codex:collaboration-mode:list"));
    assert.isTrue(handlers.has("codex:composer-plugins:list"));
    assert.isTrue(handlers.has("codex:mcp-server-statuses:list"));
    assert.isTrue(handlers.has("codex:hooks:list"));
    assert.isTrue(handlers.has("codex:hooks:state:update"));
    const event = {} as IpcMainInvokeEvent;
    const models = yield* handlers.get("codex:model:list")!(event);
    assert.strictEqual((models as readonly { id: string }[])[0]?.id, "model-a");
    const invalid = yield* handlers.get("codex:composer-plugins:list")!(event, {
      cwds: ["relative/path"],
    }).pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
    const review = yield* handlers.get("codex:review:start")!(event, {
      threadId: "source-thread",
      target: { type: "uncommittedChanges" },
    });
    assert.deepStrictEqual(review, {
      reviewThreadId: "review-thread",
      turn: {
        id: "review-turn",
        itemsView: "full",
        status: "failed",
        error: {
          message: "Request needs a narrower scope",
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: {
            errorType: "scope",
            detailedExplanation: null,
            steer: { message: "Continue with the narrowed scope" },
          },
        },
        startedAt: null,
        completedAt: null,
        durationMs: null,
        items: [
          {
            type: "functionCallOutput",
            id: "review-function-output",
            name: "external_lookup",
            namespace: null,
            output: "opaque model-context result",
          },
        ],
      },
    });

    yield* Scope.close(scope, Exit.void);
  }),
);
