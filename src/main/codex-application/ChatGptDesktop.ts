import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import {
  buildChatGptDesktopHeaders,
  prepareChatGptDesktopBody,
  resolveChatGptDesktopRequestUrl,
  resolveMissingAuthErrorMessage,
  toChatGptDesktopFetchBody,
  type ChatGptDesktopRequestInput,
} from "../codex/chatgpt-desktop-request";
import {
  ChatGptBackendAuthError,
  decodeChatGptBackendIdentity,
  readChatGptBackendRequestAuth,
  routeChatGptBackendRequest,
  type ChatGptBackendRequestAuth,
} from "../codex/chatgpt-backend-auth";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { ElectronNet, ElectronNetError } from "../platform/electron/ElectronNet";

export class ChatGptDesktopAuthError extends Schema.TaggedError<ChatGptDesktopAuthError>()(
  "ChatGptDesktopAuthError",
  { message: Schema.String },
) {}

export type ChatGptDesktopError =
  | CodexRuntimeError
  | ElectronNetError
  | ChatGptDesktopAuthError
  | ChatGptBackendAuthError;

export class ChatGptDesktop extends Context.Service<
  ChatGptDesktop,
  {
    readonly authStatus: (
      includeToken: boolean,
      refreshToken: boolean,
    ) => Effect.Effect<ClientRequestResponsesByMethod["getAuthStatus"], CodexRuntimeError>;
    readonly authMethod: Effect.Effect<string | null, CodexRuntimeError>;
    readonly request: (
      input: ChatGptDesktopRequestInput,
    ) => Effect.Effect<Response, ChatGptDesktopError>;
  }
>()("nodex/main/codex-application/ChatGptDesktop") {}

export const live: Layer.Layer<
  ChatGptDesktop,
  never,
  | CodexGateway
  | ElectronNet
  | CodexAppServerCapabilities
  | CodexWorkspaceRouting
  | CodexExecutionHostAuthState
> = Layer.effect(
  ChatGptDesktop,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const electron = yield* ElectronNet;
    const capabilities = yield* CodexAppServerCapabilities;
    const workspaceRouting = yield* CodexWorkspaceRouting;
    const authState = yield* CodexExecutionHostAuthState;
    const ownerScope = yield* Effect.scope;
    const lease = yield* SynchronizedRef.make<{
      readonly accountId: string;
      readonly userId: string;
      readonly scope: Scope.Closeable;
      readonly signal: AbortSignal;
    } | null>(null);

    const readAuth = (includeToken: boolean, refreshToken: boolean) =>
      gateway.requestLocal("getAuthStatus", { includeToken, refreshToken });

    const invalidate = SynchronizedRef.updateEffect(lease, (previous) =>
      Effect.gen(function* () {
        if (previous) yield* Scope.close(previous.scope, Exit.void);
        return null;
      }),
    );
    yield* gateway.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.kind === "connection") {
            if (event.value.hostId === gateway.localHostId && event.value.kind !== "ready")
              yield* invalidate;
            return;
          }
          if (event.hostId !== gateway.localHostId || event.value.method !== "account/updated")
            return;
          const previous = yield* SynchronizedRef.get(lease);
          if (!previous) return;
          const status = yield* readAuth(true, false).pipe(Effect.orElseSucceed(() => null));
          const identity = status?.authToken
            ? decodeChatGptBackendIdentity(status.authToken)
            : null;
          if (identity?.accountId !== previous.accountId || identity.userId !== previous.userId)
            yield* invalidate;
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    const guardAccount = Effect.fn("ChatGptDesktop.guardAccount")(function* (
      input: ChatGptDesktopRequestInput,
      auth: ChatGptBackendRequestAuth,
    ) {
      const expectedHeader = new Headers(input.headers).get("X-OpenAI-Expected-Account-Id");
      if (
        (expectedHeader !== null && expectedHeader !== auth.identity.accountId) ||
        (input.expectedAccount !== undefined &&
          (input.expectedAccount.accountId !== auth.identity.accountId ||
            input.expectedAccount.userId !== auth.identity.userId))
      ) {
        return yield* new ChatGptBackendAuthError({ message: "Authenticated workspace changed" });
      }
      return yield* SynchronizedRef.modifyEffect(lease, (current) =>
        Effect.gen(function* () {
          if (
            current?.accountId === auth.identity.accountId &&
            current.userId === auth.identity.userId
          )
            return [current.signal, current] as const;
          if (current) yield* Scope.close(current.scope, Exit.void);
          const scope = yield* Scope.fork(ownerScope);
          const signal = yield* Effect.abortSignal.pipe(Scope.provide(scope));
          return [signal, { ...auth.identity, scope, signal }] as const;
        }),
      );
    });

    const readBackendAuth = Effect.fn("ChatGptDesktop.readBackendAuth")(function* (
      input: ChatGptDesktopRequestInput,
      refreshToken: boolean,
    ) {
      return yield* readChatGptBackendRequestAuth(gateway, refreshToken).pipe(
        Effect.provideService(CodexAppServerCapabilities, capabilities),
        Effect.provideService(CodexWorkspaceRouting, workspaceRouting),
        Effect.provideService(CodexExecutionHostAuthState, authState),
        Effect.mapError((cause) =>
          cause instanceof ChatGptBackendAuthError &&
          cause.message === "ChatGPT authentication is unavailable"
            ? new ChatGptDesktopAuthError({ message: resolveMissingAuthErrorMessage(input) })
            : cause,
        ),
      );
    });

    const perform = Effect.fn("ChatGptDesktop.perform")(function* (
      input: ChatGptDesktopRequestInput,
      auth: ChatGptBackendRequestAuth,
      accountSignal: AbortSignal,
    ) {
      const prepared = prepareChatGptDesktopBody(input);
      const headers = buildChatGptDesktopHeaders(
        auth.token,
        { ...input, headers: prepared.headers },
        () => electron.appVersion,
      );
      headers.set("ChatGPT-Account-Id", auth.identity.accountId);
      const url = routeChatGptBackendRequest(
        resolveChatGptDesktopRequestUrl(input.baseUrl, input.path),
        headers,
        auth,
      );
      input.onRequestHeaders?.(headers);
      const signal = input.signal ? AbortSignal.any([accountSignal, input.signal]) : accountSignal;
      const response = yield* electron.fetch(url, {
        method: input.method,
        headers,
        body: toChatGptDesktopFetchBody(prepared.body),
        redirect: "error",
        signal,
      });
      if (signal.aborted)
        return yield* new ChatGptBackendAuthError({ message: "Authenticated workspace changed" });
      return response;
    });

    const bindResponse = (
      response: Response,
      accountSignal: AbortSignal,
      input: ChatGptDesktopRequestInput,
    ) => {
      const signal = input.signal ? AbortSignal.any([accountSignal, input.signal]) : accountSignal;
      return new Response(response.body?.pipeThrough(new TransformStream(), { signal }) ?? null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    return ChatGptDesktop.of({
      authStatus: readAuth,
      authMethod: readAuth(false, false).pipe(
        Effect.map((status) => (typeof status.authMethod === "string" ? status.authMethod : null)),
      ),
      request: (input) =>
        Effect.gen(function* () {
          const auth = yield* readBackendAuth(input, false);
          const signal = AbortSignal.any([auth.signal, yield* guardAccount(input, auth)]);
          const response = yield* perform(input, auth, signal);
          if (response.status !== 401 || input.refreshOn401 === false)
            return bindResponse(response, signal, input);
          yield* Effect.tryPromise({
            try: () => response.body?.cancel() ?? Promise.resolve(),
            catch: (cause) => new ElectronNetError({ operation: "cancel-response", cause }),
          });
          if (signal.aborted || input.signal?.aborted) {
            return yield* new ChatGptBackendAuthError({ message: "The request was canceled" });
          }
          const refreshed = yield* readBackendAuth(input, true);
          if (
            auth.identity.accountId !== refreshed.identity.accountId ||
            auth.identity.userId !== refreshed.identity.userId
          ) {
            return yield* new ChatGptBackendAuthError({
              message: "Authenticated workspace changed",
            });
          }
          yield* guardAccount(input, refreshed);
          return bindResponse(yield* perform(input, refreshed, signal), signal, input);
        }),
    });
  }),
);
