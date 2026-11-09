import { MobileRpc } from "./mobile/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { MainShutdown } from "../main/app/MainShutdown";
import { MainConfig } from "../main/app/MainConfig";
import { resolveCoreExecutable } from "../main/core-client/core-launcher";
import { hostSecretEncryption } from "../main/platform/node/HostSecretEncryption";
import { hostRepositories } from "../main/platform/node/HostRepositories";
import { HostWorkspace } from "./HostWorkspace";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../main/agent-runtime/AgentRuntimeSessionActivity";
import { ChatSearch, live as chatSearch } from "../main/chat-search/ChatSearch";
import { live as backendRegistry } from "../main/agent-backend/AgentBackendRegistry";
import { live as imageFitting } from "../main/platform/node/HostImageFitting";
import { CodexGitProbe, make as makeGitProbe } from "../main/codex-application/CodexGitProbe";
import { live as chatWorktrees } from "../main/codex-application/AgentChatWorktrees";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "../main/codex-application/CodexRendererPresentationRegistry";
import { CoreEventHub } from "../main/core-runtime/CoreEventHub";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { live as temporaryAssets } from "../main/local-store/TemporaryAssets";
import { ApplicationSettings, make as makeSettings } from "../main/settings/ApplicationSettings";
import { WorktreeShellEnvironmentRuntime } from "../main/host-runtime/WorktreeShellEnvironmentRuntime";
import { live as appToolAuthority } from "../main/app-tools/NodexAppToolAuthority";
import { layer as scopedAgentCore } from "../main/platform/node/ScopedAgentCoreServer";
import { HostAgentPolicy, scrubHostAgentEnvironment, type AgentRunner } from "./HostAgentPolicy";
import * as Core from "./CoreLive";
import * as Providers from "./ProviderConfigurationLive";
import * as Workspace from "./WorkspaceRuntimeLive";
import * as WorkspaceDependencies from "./WorkspaceDependenciesLive";
import * as AgentRuntime from "./AgentRuntimeLive";
import * as Kernel from "./HostKernel";
import * as Presence from "./UserPresence";
import * as HostMarkdown from "./HostMarkdown";
import * as SessionReminders from "./SessionReminders";
import { headless as desktopTools } from "./HostDesktopTools";
import { headless as notificationPresentation } from "./NotificationIntents";
import { HostAppToolCatalog, HostToolExecutor } from "./HostToolExecutor";
import { make as makeAppTools, hostAppToolCatalog } from "./HostApplicationTools";
import { CoordinatorSession } from "./coordinator/CoordinatorSession";
import { WorkApplication } from "./work-application/WorkApplication";
import { MemberMessages } from "./MemberMessages";
import { ChatAttachments } from "./ChatAttachments";
import { InboxApplication } from "./inbox-application/InboxApplication";
import {
  CodexUserInputAutoResolution,
  make as makeQuestionDeadlines,
} from "../main/codex-application/CodexUserInputAutoResolution";

export class HeadlessHost extends Context.Service<
  HeadlessHost,
  {
    readonly coordinator: CoordinatorSession["Service"];
    readonly work: WorkApplication["Service"];
    readonly sessions: AgentRuntimeApplication["Service"];
    readonly messages: MemberMessages["Service"];
    readonly attachments: ChatAttachments["Service"];
    readonly inbox: InboxApplication["Service"];
    readonly activity: AgentRuntimeSessionActivity["Service"];
    readonly settings: ApplicationSettings["Service"];
    readonly chats: ChatSearch["Service"];
  }
>()("nodex/host/HeadlessHost") {}

export class HeadlessHostError extends Schema.TaggedError<HeadlessHostError>()(
  "HeadlessHostError",
  {
    cause: Schema.Defect(),
  },
) {}

/** One headless Space shares its producers and execution writer with the embedded desktop Host. */
export const live = (input: {
  readonly coreHome: string;
  readonly workerDirectory: string;
  readonly agentRunner?: AgentRunner;
  readonly repositories: Readonly<Record<string, string>>;
}): Layer.Layer<
  HeadlessHost,
  HeadlessHostError,
  MainConfig | MainShutdown | FileSystem.FileSystem
> => {
  const settings = Layer.effect(
    ApplicationSettings,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const secretEncryption = yield* Effect.tryPromise(() =>
        hostSecretEncryption(
          input.coreHome,
          resolveCoreExecutable({
            environment: config.environment,
            isPackaged: config.isPackaged,
            appResourcesPath: config.resourcesPath,
            repositoryRoot: config.projectRootPath,
          }),
        ),
      );
      return yield* makeSettings({
        hostHomeDirectory: config.homeDirectory,
        environment: config.environment,
        settingsPath: config.profileSettingsPath,
        secretEncryption,
      });
    }),
  );
  const shell = Layer.effect(
    WorktreeShellEnvironmentRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      return {
        load: Effect.succeed(scrubHostAgentEnvironment(config.environment, input.coreHome)),
      };
    }),
  );
  const git = Layer.effect(
    CodexGitProbe,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      return makeGitProbe({
        environment: scrubHostAgentEnvironment(config.environment, input.coreHome),
      });
    }),
  );
  const platform = Layer.mergeAll(
    HostMarkdown.live,
    Layer.effect(
      HostWorkspace,
      Effect.gen(function* () {
        const config = yield* MainConfig;
        return yield* Effect.tryPromise(() =>
          hostRepositories({
            coreHome: input.coreHome,
            executionHome: config.nodexHome,
            repositories: input.repositories,
            environment: config.environment,
          }),
        );
      }),
    ),
    settings,
    shell,
    git,
    temporaryAssets,
    chatWorktrees,
    appToolAuthority,
    desktopTools,
    imageFitting,
    notificationPresentation,
    Layer.effect(CodexUserInputAutoResolution, makeQuestionDeadlines).pipe(
      Layer.provideMerge(Layer.effect(CodexRendererPresentationRegistry, makePresentationRegistry)),
    ),
    Layer.succeed(HostAgentPolicy, { coreHome: input.coreHome, agentRunner: input.agentRunner }),
    Layer.succeed(HostAppToolCatalog, hostAppToolCatalog),
    scopedAgentCore(input.coreHome),
  );
    Layer.provideMerge(platform),
    Layer.tap((context) =>
      Effect.gen(function* () {
        const modules = Context.get(context, CoreModules);
        const paths = Context.get(context, HostWorkspace);
        let after: string | null = null;
        do {
          const read: import("../main/core-client/types").ProjectWorkspaceReadSnapshot =
            yield* modules.workspace.read(
              { kind: "project_window", include_archived: false, window: { first: 100, after } },
              undefined,
              null,
            );
          if (read.value.kind !== "project_window")
            return yield* Effect.fail(new Error("Host Project admission is unavailable"));
          yield* Effect.forEach(
            read.value.projects.items,
            (project) => paths.resolve(project.sources),
            { concurrency: 4, discard: true },
          );
          after = read.value.projects.next_cursor ?? null;
        } while (after);
      }),
    ),
  );
  const workspace = Workspace.live({ workerDirectory: input.workerDirectory }).pipe(
    Layer.provideMerge(WorkspaceDependencies.live.pipe(Layer.provideMerge(core))),
  );
  const presence = Presence.headless.pipe(Layer.provideMerge(workspace));
  const runtime = AgentRuntime.runtime.pipe(Layer.provideMerge(presence));
  // Members search the chats they may read here, as a desktop searches its own.
  const chats = chatSearch.pipe(Layer.provideMerge(runtime));
  const work = Kernel.workApplication.pipe(Layer.provideMerge(chats));
  const applications = Kernel.applications.pipe(
    Layer.provideMerge(backendRegistry.pipe(Layer.provideMerge(work))),
  );
  const tools = AgentRuntime.hostTools.pipe(
    Layer.provide(
      Layer.effect(HostToolExecutor, makeAppTools.pipe(Effect.map((execute) => ({ execute })))),
    ),
    Layer.provideMerge(applications),
  );
  // A desktop delivers its own Member's reminders; this host delivers every Member's.
  const kernel = SessionReminders.hostedLive.pipe(
    Layer.provideMerge(Kernel.live.pipe(Layer.provideMerge(tools))),
  );
  return Layer.effect(
    HeadlessHost,
    Effect.gen(function* () {
      const kernel = yield* Kernel.HostKernel;
      const events = yield* CoreEventHub;
      yield* SubscriptionRef.changes(events.connection).pipe(
        Stream.filter((state) => state.kind === "ready"),
        Stream.take(1),
        Stream.runDrain,
        Effect.timeout("30 seconds"),
      );
      yield* kernel.synchronize;
      yield* kernel.activate;
      return {
        coordinator: yield* CoordinatorSession,
        work: yield* WorkApplication,
        sessions: yield* AgentRuntimeApplication,
        messages: yield* MemberMessages,
        attachments: yield* ChatAttachments,
        inbox: yield* InboxApplication,
        activity: yield* AgentRuntimeSessionActivity,
        settings: yield* ApplicationSettings,
        chats: yield* ChatSearch,
      };
    }),
  ).pipe(
    Layer.catch((cause) => Layer.effect(HeadlessHost, new HeadlessHostError({ cause }))),
  );
};
