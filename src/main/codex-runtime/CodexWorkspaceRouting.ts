import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import {
  resolveChatGptBackendRouting,
  RoutingRequirements,
  type ChatGptBackendIdentity,
  type ChatGptBackendRouting,
} from "../codex/chatgpt-backend-routing";
import { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import { extractCodexAppServerVersion } from "./CodexAppServerCapabilities";
import { CodexGateway } from "./CodexGateway";

export class CodexWorkspaceRoutingError extends Schema.TaggedError<CodexWorkspaceRoutingError>()(
  "CodexWorkspaceRoutingError",
  { message: Schema.String },
) {}

export interface CodexWorkspaceRoutingInput {
  readonly signal?: AbortSignal;
  readonly token: string;
  readonly identity: ChatGptBackendIdentity;
  readonly primaryHost: {
    readonly hostId: string;
    readonly generation: number;
    readonly sourceEpoch?: string;
  };
  readonly requirements: unknown;
}

export class CodexWorkspaceRouting extends Context.Service<
  CodexWorkspaceRouting,
  {
    readonly discover: (
      input: CodexWorkspaceRoutingInput,
    ) => Effect.Effect<ChatGptBackendRouting, CodexWorkspaceRoutingError>;
  }
>()("nodex/main/codex-runtime/CodexWorkspaceRouting") {}

export interface CodexWorkspaceRoutingOptions {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly temporaryDirectory?: string;
}

// These requirements control the backend destination and application network access. The
// companion must independently load the same constraints before it receives authentication.
export const workspaceRoutingRequirementsKey = (value: unknown): string => {
  const { requirements } = Schema.decodeUnknownSync(RoutingRequirements)(value);
  return JSON.stringify([
    requirements?.chatgptBaseUrl ?? null,
    requirements?.enforceResidency ?? null,
    requirements?.application?.network ?? null,
  ]);
};

const discoveryKey = (input: CodexWorkspaceRoutingInput) =>
  JSON.stringify([
    input.primaryHost.hostId,
    input.primaryHost.generation,
    input.primaryHost.sourceEpoch ?? null,
    input.identity.accountId,
    input.identity.userId,
    input.identity.isFedramp,
    input.requirements,
  ]);

const privateEnvironment = (
  environment: CodexWorkspaceRoutingOptions["environment"],
  home: string,
) => {
  const allowed = [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ];
  const result: Record<string, string | undefined> = Object.fromEntries(
    allowed.map((key) => [key, environment[key]]),
  );
  return { ...result, CODEX_HOME: home, RUST_LOG: "off" };
};

export const make = (options: CodexWorkspaceRoutingOptions) =>
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const transport = yield* CodexSessionTransport;
    const fs = yield* FileSystem.FileSystem;
    const epoch = yield* SubscriptionRef.make(0);
    const cache = yield* Ref.make<{
      readonly key: string;
      readonly routing: ChatGptBackendRouting;
      readonly signal?: AbortSignal;
    } | null>(null);
    const lock = yield* Semaphore.make(1);

    yield* gateway.events.pipe(
      Stream.filter((event) =>
        event.kind === "notification"
          ? event.hostId === gateway.localHostId && event.value.method === "account/updated"
          : event.value.hostId === gateway.localHostId && event.value.kind !== "ready",
      ),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          yield* Ref.set(cache, null);
          yield* SubscriptionRef.update(epoch, (value) => value + 1);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    const fetchRoute = Effect.fn("CodexWorkspaceRouting.fetchRoute")(
      function* (input: CodexWorkspaceRoutingInput) {
        if (options.browserRuntime.status !== "available") {
          return yield* new CodexWorkspaceRoutingError({
            message: "The verified workspace routing runtime is unavailable",
          });
        }
        const expectedRequirements = yield* Effect.try({
          try: () => workspaceRoutingRequirementsKey(input.requirements),
          catch: () =>
            new CodexWorkspaceRoutingError({ message: "Invalid primary workspace requirements" }),
        });
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "nodex-workspace-routing-",
          directory: options.temporaryDirectory,
        });
        yield* fs.chmod(home, 0o700);
        const session = yield* transport.open({
          hostId: "workspace-routing",
          generation: input.primaryHost.generation,
          command: options.browserRuntime.bundle.paths.codexCli,
          args: ["app-server", "-c", 'cli_auth_credentials_store="ephemeral"'],
          cwd: home,
          env: privateEnvironment(options.environment, home),
          forceTermination: "1 second",
        });
        const client = session.client;
        const initialized = yield* client.request("initialize", {
          clientInfo: { name: "nodex", version: "1" },
          capabilities: { experimentalApi: true },
        });
        const version = extractCodexAppServerVersion(initialized.userAgent);
        if (version !== options.browserRuntime.bundle.manifest.runtimeVersions.codexCli) {
          return yield* new CodexWorkspaceRoutingError({
            message: "Workspace routing runtime identity changed",
          });
        }
        yield* client.notify("initialized", undefined);
        const verifyRequirements = Effect.gen(function* () {
          const response = yield* client.raw.request("configRequirements/read", {});
          const actual = yield* Effect.try({
            try: () => workspaceRoutingRequirementsKey(response),
            catch: () =>
              new CodexWorkspaceRoutingError({
                message: "Invalid companion workspace requirements",
              }),
          });
          if (actual !== expectedRequirements) {
            return yield* new CodexWorkspaceRoutingError({
              message:
                "Workspace routing cannot preserve the primary host's network and residency requirements",
            });
          }
        });
        yield* verifyRequirements;
        yield* client.request("account/login/start", {
          type: "chatgptAuthTokens",
          accessToken: input.token,
          chatgptAccountId: input.identity.accountId,
        });
        const account = yield* client.raw.request("account/read", { refreshToken: false });
        yield* verifyRequirements;
        const routing = yield* Effect.try({
          try: () =>
            resolveChatGptBackendRouting({
              account,
              requirements: input.requirements,
              version,
              identity: input.identity,
            }),
          catch: () =>
            new CodexWorkspaceRoutingError({
              message: "The workspace routing runtime did not return an authenticated route",
            }),
        });
        if (routing.kind !== "workspace") {
          return yield* new CodexWorkspaceRoutingError({
            message: "The workspace routing runtime did not return an explicit route",
          });
        }
        return routing;
      },
      Effect.scoped,
      Effect.mapError((error) =>
        Schema.is(CodexWorkspaceRoutingError)(error)
          ? error
          : new CodexWorkspaceRoutingError({
              message: "Unable to discover authenticated workspace routing",
            }),
      ),
    );

    const discover = Effect.fn("CodexWorkspaceRouting.discover")(
      function* (input: CodexWorkspaceRoutingInput) {
        const capturedEpoch = yield* SubscriptionRef.get(epoch);
        const canceled = Effect.callback<never, CodexWorkspaceRoutingError>((resume) => {
          const onAbort = () =>
            resume(
              Effect.fail(
                new CodexWorkspaceRoutingError({ message: "Authenticated workspace changed" }),
              ),
            );
          if (input.signal?.aborted) onAbort();
          else input.signal?.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => input.signal?.removeEventListener("abort", onAbort));
        });
        return yield* Effect.gen(function* () {
          if (input.signal?.aborted || (yield* SubscriptionRef.get(epoch)) !== capturedEpoch)
            return yield* new CodexWorkspaceRoutingError({
              message: "Authenticated workspace changed",
            });
          const key = discoveryKey(input);
          const previous = yield* Ref.get(cache);
          if (previous?.key === key && !previous.signal?.aborted) return previous.routing;
          const invalidated = SubscriptionRef.changes(epoch).pipe(
            Stream.filter((value) => value !== capturedEpoch),
            Stream.take(1),
            Stream.runDrain,
            Effect.andThen(
              new CodexWorkspaceRoutingError({ message: "Authenticated workspace changed" }),
            ),
          );
          const routing = yield* fetchRoute(input).pipe(Effect.raceFirst(invalidated));
          if ((yield* SubscriptionRef.get(epoch)) !== capturedEpoch) {
            return yield* new CodexWorkspaceRoutingError({
              message: "Authenticated workspace changed",
            });
          }
          yield* Ref.set(cache, { key, routing, signal: input.signal });
          return routing;
        }).pipe(lock.withPermits(1), Effect.raceFirst(canceled));
      },
      Effect.timeout("10 seconds"),
      Effect.mapError((error) =>
        Schema.is(CodexWorkspaceRoutingError)(error)
          ? error
          : new CodexWorkspaceRoutingError({ message: "Workspace routing discovery timed out" }),
      ),
    );
    return CodexWorkspaceRouting.of({ discover });
  });

export const live = (options: CodexWorkspaceRoutingOptions) =>
  Layer.effect(CodexWorkspaceRouting, make(options));
