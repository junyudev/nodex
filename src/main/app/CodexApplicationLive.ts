import {
  CodexMainConversationManagers,
  make as makeMainConversationManagers,
} from "../codex-application/CodexMainConversationManagers";
import { CodexConversationPeerRuntime } from "../platform/node/CodexConversationPeerRuntime";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CODEX_INTEGRATION_CAPABILITIES } from "../../shared/codex-integration-capabilities";
import { codexCliAppServerArgs } from "../../shared/codex-app-server-launch";
import { resolveCodexRuntime } from "../codex/codex-runtime";
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
  CodexPermissions,
  live as codexPermissionsLive,
} from "../codex-application/CodexPermissions";
import {
  CodexPreferences,
  live as codexPreferencesLive,
} from "../codex-application/CodexPreferences";
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
import { nodexCliShellLaunchArgs, prepareNodexCliShell } from "../platform/node/NodexCliShell";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AppProtocolRuntime } from "../host-runtime/AppProtocolRuntime";
import { CoreModules } from "../core-runtime/CoreModules";
import { MainConfig } from "./MainConfig";
import { MainApplicationError } from "./MainExit";
import {
  AppToolInvocationInbox,
  make as makeAppToolInvocationInbox,
} from "../app-tools/AppToolInvocationInbox";
import { make as makeAppToolSession } from "../app-tools/CodexAppToolSession";
import { appToolsEntrypoint } from "../codex/app-tools-launch-config";
import type { CodexAppServerSessionOptions } from "../codex-runtime/CodexAppServerSession";

export class CodexPlatform extends Context.Service<
  CodexPlatform,
  {
    readonly runtime: ReturnType<typeof resolveCodexRuntime>;
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
    return CodexPlatform.of({
      runtime,
      runtimeStateHome: `${config.nodexHome}/agent`,
    });
  }),
);

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
    const cliArgs =
      config.platform === "win32"
        ? []
        : yield* Effect.tryPromise(() => prepareNodexCliShell(config.nodexHome)).pipe(
            Effect.andThen(
              Effect.tryPromise(() =>
                nodexCliShellLaunchArgs({
                  nodexHome: config.nodexHome,
                  runtimeStateHome: codex.runtimeStateHome,
                  searchPaths: codex.runtime.additionalSearchPaths,
                  inheritedPath: config.environmentPath ?? "",
                  homeDirectory: config.homeDirectory,
                  inheritedZdotdir: config.environment.ZDOTDIR,
                  inheritedBashEnv: config.environment.BASH_ENV,
                }),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new MainApplicationError({
                  phase: "startup",
                  operation: "prepare-cli-shell",
                  cause,
                }),
            ),
          );
    const appToolSession = yield* makeAppToolSession;
    const local: Omit<CodexAppServerSessionOptions, "generation"> = {
      hostId: "local",
      command: codex.runtime.binaryPath,
      localDaemon: {
        codexHome: codex.runtimeStateHome,
        platform: config.platform,
        resourcesPath: config.resourcesPath,
        configOverrides: cliArgs,
      },
      args: [...codexCliAppServerArgs(config.environment), ...cliArgs],
      env: {},
      resolveEnv: () =>
        resolveCodexProcessEnvironment({
          additionalSearchPaths: codex.runtime.additionalSearchPaths,
          pathDelimiter: config.platform === "win32" ? ";" : ":",
          runtimeStateHome: codex.runtimeStateHome,
        }),
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
      expectedCodexHome: codex.runtimeStateHome,
    };
    const browserRuntime = codex.runtime.browserRuntime;
    return CodexRuntimeLive.live({
      local,
      internalServerRequestHandler: (request) =>
        request.method === "attestation/generate" ? codexAttestation.generate : null,
      ...(browserRuntime.status === "available"
        ? {
            localSessionLayer: (generation: number) =>
              appToolSession(
                { ...local, generation },
                {
                  runtime: browserRuntime.bundle,
                  entrypoint: appToolsEntrypoint(config),
                },
              ),
          }
        : {}),
    });
  }),
);

const conversationEntities = conversationEntityMapLive;
const conversations = codexConversationsLive.pipe(Layer.provideMerge(conversationEntities));
const appToolInvocations = Layer.effect(AppToolInvocationInbox, makeAppToolInvocationInbox);
const foundations = Layer.mergeAll(
  platform,
  attestation,
  requestInbox,
  appToolInvocations,
  conversations,
  CodexSessionTransport.nodeLive,
);
const transport = runtime.pipe(Layer.provideMerge(foundations));
const kernel = pendingRequests.pipe(Layer.provideMerge(transport));

const account = codexAccountLive({ pollInterval: "60 seconds" }).pipe(Layer.provideMerge(kernel));
const catalog = composerCatalogLive.pipe(Layer.provideMerge(kernel));
const events = Layer.effect(CodexApplicationEventHub, makeCodexApplicationEventHub);
const connection = codexConnectionLive.pipe(Layer.provideMerge(Layer.mergeAll(kernel, events)));
const tools = codexToolRuntimeLive({
  supportsChatGptApps: CODEX_INTEGRATION_CAPABILITIES.chatGptApps,
}).pipe(Layer.provideMerge(Layer.merge(kernel, account)));
const permissions = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return codexPermissionsLive({ runtimeStateHome: codex.runtimeStateHome });
  }),
).pipe(Layer.provideMerge(kernel));

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
  permissions,
  events,
  rendererPresentation,
  readState,
  mainManagers,
  userInputAutoResolution,
  serverRequestResponses,
);

/** Stable Codex host generations and application-owned conversation foundations. */
export const live: Layer.Layer<
  | CodexPlatform
  | CodexAttestation
  | AppToolInvocationInbox
  | CodexApplicationRequestInbox
  | CodexPendingServerRequestRuntime
  | CodexConversations
  | ConversationEntityMap
  | CodexGateway
  | CodexAppServerCapabilities
  | CodexRequestScheduler
  | CodexEndpointMap
  | CodexEventHub
  | CodexAccount
  | ComposerCatalog
  | CodexConnection
  | CodexToolRuntime
  | CodexPreferences
  | CodexPermissions
  | CodexApplicationEventHub
  | CodexRendererPresentationRegistry
  | CodexThreadReadState
  | CodexMainConversationManagers
  | CodexUserInputAutoResolution
  | CodexServerRequestResponses,
  MainApplicationError,
  | MainConfig
  | AppProtocolRuntime
  | CodexThreadHostResolver
  | ProjectWorkspace
  | CoreModules
  | ApplicationSettings
  | CodexConversationPeerRuntime
  | ScopedCallbackRuntime
> = applicationServices;
