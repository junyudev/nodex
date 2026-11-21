import { ExecutionNode, live as executionNodeLive } from "../../host/ExecutionNodeLive";
import { localLaunch } from "../../host/ProviderConfigurationLive";
import {
  PluginNativeOperations,
  live as pluginNativeOperationsLive,
} from "../codex-application/PluginNativeOperations";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import {
  CodexMainConversationManagers,
  make as makeMainConversationManagers,
} from "../codex-application/CodexMainConversationManagers";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import {
  assertCodexAccountHomeIdentity,
  codexAccountHomeEnvironment,
} from "../platform/node/CodexAccountHome";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexPlatform, CodexLocalLaunch } from "../../host/ProviderPlatform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { CODEX_INTEGRATION_CAPABILITIES } from "../../shared/codex-integration-capabilities";
import { codexCliAppServerArgs } from "../../shared/codex-app-server-launch";
import { CodexAccount, live as codexAccountLive } from "../codex-application/CodexAccount";
import {
  CodexAttestation,
  supportsCodexAttestationRequests,
} from "../codex-application/CodexAttestation";
import {
  CodexApplicationEventHub,
  make as makeCodexApplicationEventHub,
} from "../codex-application/CodexApplicationEventHub";
import { CodexConnection, live as codexConnectionLive } from "../codex-application/CodexConnection";
import {
  CodexPendingServerRequestRuntime,
  make as makeCodexPendingServerRequestRuntime,
} from "../codex-application/CodexPendingServerRequestRuntime";

import {
  CodexPreferences,
  live as codexPreferencesLive,
} from "../codex-application/CodexPreferences";
import { UserPresence } from "../../host/UserPresence";
import { live as userPresenceLive } from "../host-runtime/UserPresence";
import {
  CodexRendererPresentationRegistry,
  make as makeCodexRendererPresentationRegistry,
} from "../codex-application/CodexRendererPresentationRegistry";
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
import * as CodexSessionTransport from "../platform/node/CodexSessionTransport";
import { live as electronCodexAttestationLive } from "../platform/electron/ElectronCodexAttestation";
import { resolveCodexProcessEnvironment } from "../platform/node/CodexProcessEnvironment";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AppProtocolRuntime } from "../host-runtime/AppProtocolRuntime";
import { MainConfig } from "./MainConfig";
import { MainApplicationError } from "./MainExit";
import {
  AppToolInvocationInbox,
  make as makeAppToolInvocationInbox,
} from "../app-tools/AppToolInvocationInbox";
import { make as makeAppToolSession } from "../app-tools/CodexAppToolSession";
import { appToolsEntrypoint } from "../codex/app-tools-launch-config";
import {
  live as codexSessionLive,
  type CodexAppServerSessionOptions,
} from "../codex-runtime/CodexAppServerSession";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";

import * as Option from "effect/Option";
import { WorktreeShellEnvironmentRuntime } from "../host-runtime/WorktreeShellEnvironmentRuntime";
import { AppComponents } from "../app-components/AppComponents";
import { admitCodexPackage, ensureCodexComponent } from "../app-components/CodexComponent";

const requestInbox = Layer.effect(CodexApplicationRequestInbox, makeCodexApplicationRequestInbox);

const attestation = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return electronCodexAttestationLive({
      architecture: config.arch,
      isPackaged: config.isPackaged,
      platform: config.platform as NodeJS.Platform,
      projectRootPath: config.projectRootPath,
      resourcesPath: config.resourcesPath,
    });
  }),
);

const pendingRequests = Layer.effect(
  CodexPendingServerRequestRuntime,
  Effect.gen(function* () {
    const inbox = yield* CodexApplicationRequestInbox;
    return yield* makeCodexPendingServerRequestRuntime({
      abandon: (_threadId, _requestId, occurrenceToken) =>
        inbox.settleOccurrenceToken(occurrenceToken, { kind: "abandon" }),
      respond: (_threadId, _requestId, occurrenceToken, response, trace) =>
        inbox.settleOccurrenceToken(occurrenceToken, { kind: "result", value: response }, trace),
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
    const codexAttestation = yield* CodexAttestation;
    const { configOverrides, prepareAccount } = yield* CodexLocalLaunch;
    const nodeRuntime = yield* ExecutionNode;
    const appToolSession = yield* makeAppToolSession;
    const components = yield* AppComponents;
    const shell = Option.getOrUndefined(
      yield* Effect.serviceOption(WorktreeShellEnvironmentRuntime),
    );
    const requirePackage = admitCodexPackage(components, codex.ordinaryPackageAfterStartupCheck);
    const prepare = yield* Effect.cached(
      Effect.gen(function* () {
        const codexPackage = yield* codex.usesExternalExecutable
          ? requirePackage
          : codex.package.available;
        const loginPath =
          codexPackage.source === "external" && shell
            ? yield* shell.load.pipe(
                Effect.map((environment) => environment.PATH),
                Effect.orElseSucceed(() => undefined),
              )
            : undefined;
        const args = yield* configOverrides(codexPackage).pipe(
          Effect.mapError((cause) =>
            codexRuntimeError({
              operation: "session.prepare-launch",
              reason: "spawn",
              retryable: false,
              cause,
            }),
          ),
        );
        const accountHome = yield* prepareAccount.pipe(
          Effect.mapError((cause) =>
            codexRuntimeError({
              operation: "session.prepare-account",
              reason: "spawn",
              retryable: false,
              cause,
            }),
          ),
        );
        return {
          hostId: "local",
          command: codexPackage.binaryPath,
          localDaemon: {
            codexHome: accountHome.effectiveHome,
            platform: config.platform,
            resourcesPath: config.resourcesPath,
            configOverrides: args,
            commandOverride: codexPackage.source === "external",
          },
          args: [...codexCliAppServerArgs(config.environment), ...args],
          env: {},
          resolveEnv: () =>
            Effect.try({
              try: () => {
                assertCodexAccountHomeIdentity(accountHome, config.platform);
                return codexAccountHomeEnvironment(accountHome, config.environment);
              },
              catch: (cause) =>
                codexRuntimeError({
                  operation: "session.validate-account-home",
                  reason: "spawn",
                  retryable: false,
                  hostId: "local",
                  cause,
                }),
            }).pipe(
              Effect.flatMap((environment) =>
                resolveCodexProcessEnvironment({
                  additionalSearchPaths: codexPackage.additionalSearchPaths,
                  pathDelimiter: config.platform === "win32" ? ";" : ":",
                  codexHome: accountHome.effectiveHome,
                  environment: loginPath ? { ...environment, PATH: loginPath } : environment,
                }),
              ),
            ),
          forceTermination: "2 seconds",
          initializeParams: {
            clientInfo: { name: "nodex", title: "Nodex", version: "0.5.0" },
            capabilities: {
              experimentalApi: true,
              extensions: { "openai/form": {} },
              requestAttestation: supportsCodexAttestationRequests(config.platform),
            },
          },
          initializeTimeout: "20 seconds",
          expectedCodexHome: accountHome.effectiveHome,
        } satisfies Omit<CodexAppServerSessionOptions, "generation">;
      }),
    );
    return CodexRuntimeLive.live({
      endpoint: CodexRuntimeLive.localEndpointConfig({
        transportKind: "websocket",
        checkAvailability: requirePackage.pipe(Effect.asVoid),
        sessionLayer: (generation) =>
          Layer.unwrap(
            prepare.pipe(
              Effect.map((local) =>
                nodeRuntime.status === "available"
                  ? appToolSession(
                      { ...local, generation },
                      {
                        nodeExecutable: nodeRuntime.executable,
                        entrypoint: appToolsEntrypoint(config),
                      },
                    )
                  : codexSessionLive({ ...local, generation }),
              ),
            ),
          ),
      }),
      internalServerRequestHandler: (request) =>
        request.method === "attestation/generate" ? codexAttestation.generate : null,
    });
  }),
);

const conversationEntities = conversationEntityMapLive;
const conversations = codexConversationsLive.pipe(Layer.provideMerge(conversationEntities));
const appToolInvocations = Layer.effect(AppToolInvocationInbox, makeAppToolInvocationInbox);
const foundations = Layer.mergeAll(
  executionNodeLive,
  CodexSessionTransport.nodeLive,
  attestation,
  requestInbox,
  appToolInvocations,
  conversations,
);
const transport = runtime.pipe(Layer.provideMerge(localLaunch), Layer.provideMerge(foundations));
const kernel = pendingRequests.pipe(Layer.provideMerge(transport));

const account = Layer.unwrap(
  Effect.gen(function* () {
    const settings = yield* ApplicationSettings;
    const snapshot = yield* settings.snapshot().pipe(Effect.orDie);
    const components = yield* AppComponents;
    const codex = yield* CodexPlatform;
    return codexAccountLive({
      prepareSignIn: codex.usesExternalExecutable
        ? admitCodexPackage(components, codex.ordinaryPackageAfterStartupCheck).pipe(Effect.asVoid)
        : ensureCodexComponent(components),
      pollInterval: "60 seconds",
      meterEnabled: snapshot.usageMeters.codex,
      meterEnabledChanges: settings.usageMeterSettingsChanges.pipe(
        Stream.map((value) => value.codex),
      ),
    });
  }),
).pipe(Layer.provideMerge(kernel));
const nativePlugins = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return pluginNativeOperationsLive({ runtimeStateHome: codex.runtimeStateHome });
  }),
).pipe(Layer.provideMerge(kernel));
const catalog = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return composerCatalogLive({ runtimeStateHome: codex.runtimeStateHome });
  }),
).pipe(Layer.provideMerge(nativePlugins));
const events = Layer.effect(CodexApplicationEventHub, makeCodexApplicationEventHub);
const connection = codexConnectionLive.pipe(Layer.provideMerge(Layer.mergeAll(kernel, events)));
const tools = codexToolRuntimeLive({
  supportsChatGptApps: CODEX_INTEGRATION_CAPABILITIES.chatGptApps,
}).pipe(Layer.provideMerge(Layer.merge(kernel, account)));

const rendererPresentation = Layer.effect(
  CodexRendererPresentationRegistry,
  makeCodexRendererPresentationRegistry,
);
const readState = Layer.effect(CodexThreadReadState, makeCodexThreadReadState).pipe(
  Layer.provideMerge(Layer.mergeAll(events, kernel)),
);
const mainManagers = Layer.effect(CodexMainConversationManagers, makeMainConversationManagers).pipe(
  Layer.provideMerge(readState),
);
const userPresence = userPresenceLive.pipe(
  Layer.provideMerge(Layer.mergeAll(events, rendererPresentation)),
);
const userInputAutoResolution = Layer.effect(
  CodexUserInputAutoResolution,
  makeCodexUserInputAutoResolution,
).pipe(Layer.provideMerge(rendererPresentation));
const serverRequestResponses = Layer.effect(
  CodexServerRequestResponses,
  makeCodexServerRequestResponses,
).pipe(Layer.provideMerge(Layer.mergeAll(events, readState, userInputAutoResolution, kernel)));

const applicationServices = Layer.mergeAll(
  account,
  catalog,
  connection,
  tools,
  codexPreferencesLive,
  events,
  rendererPresentation,
  userPresence,
  readState,
  mainManagers,
  userInputAutoResolution,
  serverRequestResponses,
);

/** Stable Codex host generations and application-owned conversation foundations. */
export const live: Layer.Layer<
  | ExecutionNode
  | CodexLocalLaunch
  | CodexAttestation
  | AppToolInvocationInbox
  | CodexApplicationRequestInbox
  | CodexPendingServerRequestRuntime
  | CodexConversations
  | ConversationEntityMap
  | CodexGateway
  | CodexAppServerCapabilities
  | CodexExecutionHostAuthState
  | CodexRequestScheduler
  | CodexEndpointMap
  | CodexEventHub
  | CodexAccount
  | ComposerCatalog
  | PluginNativeOperations
  | CodexConnection
  | CodexToolRuntime
  | CodexPreferences
  | CodexApplicationEventHub
  | CodexRendererPresentationRegistry
  | UserPresence
  | CodexThreadReadState
  | CodexMainConversationManagers
  | CodexUserInputAutoResolution
  | CodexServerRequestResponses,
  MainApplicationError,
  | MainConfig
  | CodexPlatform
  | AppComponents
  | AppProtocolRuntime
  | CodexThreadHostResolver
  | ProjectWorkspace
  | ApplicationSettings
  | CodexConversationPeerRuntime
  | ScopedCallbackRuntime
> = applicationServices;
