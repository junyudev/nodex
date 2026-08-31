import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CODEX_INTEGRATION_CAPABILITIES } from "../../shared/codex-integration-capabilities";
import { resolveCodexRuntime } from "../codex/codex-runtime";
import {
  AgentProviderRuntime,
  live as agentProviderRuntimeLive,
} from "../codex-application/AgentProviderRuntime";
import { CodexAccount, live as codexAccountLive } from "../codex-application/CodexAccount";
import {
  CodexApplicationEventHub,
  make as makeCodexApplicationEventHub,
} from "../codex-application/CodexApplicationEventHub";
import {
  CodexAttachments,
  live as codexAttachmentsLive,
} from "../codex-application/CodexAttachments";
import { CodexConnection, live as codexConnectionLive } from "../codex-application/CodexConnection";
import {
  CodexOwnerNotificationDrainRuntime,
  make as makeCodexOwnerNotificationDrainRuntime,
} from "../codex-application/CodexOwnerNotificationDrainRuntime";
import {
  CodexPendingServerRequestRuntime,
  make as makeCodexPendingServerRequestRuntime,
} from "../codex-application/CodexPendingServerRequestRuntime";
import {
  CodexPermissions,
  live as codexPermissionsLive,
} from "../codex-application/CodexPermissions";
import {
  CodexPreferences,
  live as codexPreferencesLive,
} from "../codex-application/CodexPreferences";
import {
  CodexRendererConversationCoordinator,
  make as makeCodexRendererConversationCoordinator,
} from "../codex-application/CodexRendererConversationCoordinator";
import {
  CodexRendererConversationRegistry,
  make as makeCodexRendererConversationRegistry,
} from "../codex-application/CodexRendererConversationRegistry";
import {
  CodexRendererOwnerRetention,
  make as makeCodexRendererOwnerRetention,
} from "../codex-application/CodexRendererOwnerRetention";
import {
  CodexServerRequestResponses,
  make as makeCodexServerRequestResponses,
} from "../codex-application/CodexServerRequestResponses";
import {
  CodexThreadReadState,
  make as makeCodexThreadReadState,
} from "../codex-application/CodexThreadReadState";
import {
  CodexToolRuntime,
  live as codexToolRuntimeLive,
} from "../codex-application/CodexToolRuntime";
import {
  CodexUserInputAutoResolution,
  make as makeCodexUserInputAutoResolution,
} from "../codex-application/CodexUserInputAutoResolution";
import { ComposerCatalog, live as composerCatalogLive } from "../codex-application/ComposerCatalog";
import {
  CodexConversations,
  live as codexConversationsLive,
} from "../codex-application/CodexConversations";
import {
  ConversationEntityMap,
  live as conversationEntityMapLive,
} from "../codex-application/internal/ConversationEntityMap";
import {
  CodexApplicationRequestInbox,
  make as makeCodexApplicationRequestInbox,
} from "../codex-runtime/CodexApplicationRequestInbox";
import { CodexEndpointMap } from "../codex-runtime/CodexEndpointMap";
import { CodexEventHub } from "../codex-runtime/CodexEventHub";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import * as CodexRuntimeLive from "../codex-runtime/CodexRuntimeLive";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexRequestScheduler } from "../codex-runtime/CodexRequestScheduler";
import {
  createElectronProviderCredentialStore,
  type ProviderCredentialStore,
} from "../platform/electron/ProviderCredentialStore";
import * as ProviderCredentials from "../platform/electron/ProviderCredentials";
import * as CodexSessionTransport from "../platform/node/CodexSessionTransport";
import { resolveCodexProcessEnvironment } from "../platform/node/CodexProcessEnvironment";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CoreModules } from "../core-runtime/CoreModules";
import { getThreadGoalAttachmentsRoot } from "../thread-goal-attachments";
import { MainConfig } from "./MainConfig";
import { MainApplicationError } from "./MainExit";

export class CodexPlatform extends Context.Service<
  CodexPlatform,
  {
    readonly runtime: ReturnType<typeof resolveCodexRuntime>;
    readonly providerCredentialStore: ProviderCredentialStore;
    readonly runtimeStateHome: string;
  }
>()("nodex/main/app/CodexPlatform") {}

const platform: Layer.Layer<CodexPlatform, MainApplicationError, MainConfig> = Layer.effect(
  CodexPlatform,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const testRuntimeProjectRoot =
      config.environment.NODE_ENV === "test"
        ? config.environment.NODEX_TEST_AGENT_RUNTIME_PROJECT_ROOT?.trim()
        : undefined;
    const runtime = yield* Effect.try({
      try: () =>
        resolveCodexRuntime({
          isPackaged: config.isPackaged,
          projectRootPath: testRuntimeProjectRoot || config.projectRootPath,
          resourcesPath: config.resourcesPath,
        }),
      catch: (cause) =>
        new MainApplicationError({ phase: "startup", operation: "resolve-codex-runtime", cause }),
    });
    const providerCredentialStore = yield* Effect.try({
      try: () =>
        createElectronProviderCredentialStore(
          `${config.nodexHome}/secrets/provider-credentials.v1.json`,
        ),
      catch: (cause) =>
        new MainApplicationError({ phase: "startup", operation: "provider-credentials", cause }),
    });
    return CodexPlatform.of({
      runtime,
      providerCredentialStore,
      runtimeStateHome: `${config.nodexHome}/agent`,
    });
  }),
);

const requestInbox = Layer.effect(CodexApplicationRequestInbox, makeCodexApplicationRequestInbox);

const pendingRequests = Layer.effect(
  CodexPendingServerRequestRuntime,
  Effect.gen(function* () {
    const inbox = yield* CodexApplicationRequestInbox;
    return yield* makeCodexPendingServerRequestRuntime({
      respond: (_threadId, _requestId, occurrenceToken, response) =>
        inbox.settleOccurrenceToken(occurrenceToken, { kind: "result", value: response }),
      reject: (_threadId, requestId, occurrenceToken, reason) =>
        inbox.settleOccurrenceToken(occurrenceToken, {
          kind: "error",
          error: CodexAppServerRequestError.internalError(
            "Codex application request failed",
            undefined,
            {
              operation: "handle-request",
              requestId: String(requestId),
              cause: reason,
            },
          ),
        }),
    });
  }),
);

const runtime = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    return CodexRuntimeLive.live({
      local: {
        hostId: "local",
        command: codex.runtime.binaryPath,
        args: ["app-server", "--listen", "stdio://"],
        env: {},
        resolveEnv: () =>
          resolveCodexProcessEnvironment({
            additionalSearchPaths: codex.runtime.additionalSearchPaths,
            pathDelimiter: config.platform === "win32" ? ";" : ":",
            providerCredentialStore: codex.providerCredentialStore,
            runtimeStateHome: codex.runtimeStateHome,
          }),
        forceTermination: "2 seconds",
        initializeParams: {
          clientInfo: { name: "nodex", title: "Nodex", version: "0.5.0" },
          capabilities: {
            experimentalApi: true,
            extensions: { "openai/form": {} },
            requestAttestation: false,
          },
        },
        initializeTimeout: "20 seconds",
        expectedCodexHome: codex.runtimeStateHome,
      },
      requestTimeout: "180 seconds",
    });
  }),
);

const conversationEntities = conversationEntityMapLive;
const conversations = codexConversationsLive.pipe(Layer.provideMerge(conversationEntities));
const foundations = Layer.mergeAll(
  platform,
  requestInbox,
  conversations,
  CodexSessionTransport.nodeLive,
);
const transport = runtime.pipe(Layer.provideMerge(foundations));
const kernel = pendingRequests.pipe(Layer.provideMerge(transport));

const providerCredentials = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return ProviderCredentials.fromStore(codex.providerCredentialStore);
  }),
);

const account = codexAccountLive({ pollInterval: "60 seconds" }).pipe(Layer.provideMerge(kernel));
const provider = agentProviderRuntimeLive.pipe(
  Layer.provideMerge(Layer.merge(kernel, providerCredentials.pipe(Layer.provideMerge(platform)))),
);
const catalog = composerCatalogLive.pipe(Layer.provideMerge(kernel));
const connection = codexConnectionLive.pipe(Layer.provideMerge(kernel));
const tools = codexToolRuntimeLive({
  supportsChatGptApps: CODEX_INTEGRATION_CAPABILITIES.chatGptApps,
}).pipe(Layer.provideMerge(Layer.merge(kernel, account)));
const attachments = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return codexAttachmentsLive(getThreadGoalAttachmentsRoot(codex.runtimeStateHome));
  }),
).pipe(Layer.provideMerge(platform));
const permissions = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return codexPermissionsLive({ runtimeStateHome: codex.runtimeStateHome });
  }),
).pipe(Layer.provideMerge(kernel));

const events = Layer.effect(CodexApplicationEventHub, makeCodexApplicationEventHub);
const notificationDrain = Layer.effect(
  CodexOwnerNotificationDrainRuntime,
  makeCodexOwnerNotificationDrainRuntime(),
);
const rendererRegistry = Layer.effect(
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistry(),
);
const readState = Layer.effect(CodexThreadReadState, makeCodexThreadReadState).pipe(
  Layer.provideMerge(Layer.mergeAll(events, rendererRegistry, kernel)),
);
const userInputAutoResolution = Layer.effect(
  CodexUserInputAutoResolution,
  makeCodexUserInputAutoResolution,
).pipe(Layer.provideMerge(rendererRegistry));
const rendererOwnerRetention = Layer.effect(
  CodexRendererOwnerRetention,
  makeCodexRendererOwnerRetention(),
).pipe(Layer.provideMerge(Layer.mergeAll(events, notificationDrain, rendererRegistry, kernel)));
const rendererCoordinator = Layer.effect(
  CodexRendererConversationCoordinator,
  makeCodexRendererConversationCoordinator,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      events,
      notificationDrain,
      rendererRegistry,
      rendererOwnerRetention,
      userInputAutoResolution,
      kernel,
    ),
  ),
);
const serverRequestResponses = Layer.effect(
  CodexServerRequestResponses,
  makeCodexServerRequestResponses,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      events,
      notificationDrain,
      rendererRegistry,
      readState,
      userInputAutoResolution,
      kernel,
    ),
  ),
);

const applicationServices = Layer.mergeAll(
  account,
  provider,
  catalog,
  connection,
  tools,
  codexPreferencesLive,
  attachments,
  permissions,
  events,
  notificationDrain,
  rendererRegistry,
  readState,
  userInputAutoResolution,
  rendererOwnerRetention,
  rendererCoordinator,
  serverRequestResponses,
);

/** Stable Codex host generations and application-owned conversation foundations. */
export const live: Layer.Layer<
  | CodexPlatform
  | CodexApplicationRequestInbox
  | CodexPendingServerRequestRuntime
  | CodexConversations
  | ConversationEntityMap
  | CodexGateway
  | CodexAppServerCapabilities
  | CodexRequestScheduler
  | CodexEndpointMap
  | CodexEventHub
  | ProviderCredentials.ProviderCredentials
  | AgentProviderRuntime
  | CodexAccount
  | ComposerCatalog
  | CodexConnection
  | CodexToolRuntime
  | CodexPreferences
  | CodexAttachments
  | CodexPermissions
  | CodexApplicationEventHub
  | CodexOwnerNotificationDrainRuntime
  | CodexRendererConversationRegistry
  | CodexThreadReadState
  | CodexUserInputAutoResolution
  | CodexRendererOwnerRetention
  | CodexRendererConversationCoordinator
  | CodexServerRequestResponses,
  MainApplicationError,
  MainConfig | CodexThreadHostResolver | ProjectWorkspace | CoreModules
> = applicationServices;
