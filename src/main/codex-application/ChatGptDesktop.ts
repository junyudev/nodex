import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
import { ElectronNet, type ElectronNetError } from "../platform/electron/ElectronNet";

export class ChatGptDesktopAuthError extends Schema.TaggedError<ChatGptDesktopAuthError>()(
  "ChatGptDesktopAuthError",
  { message: Schema.String },
) {}

export type ChatGptDesktopError = CodexRuntimeError | ElectronNetError | ChatGptDesktopAuthError;

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

const isChatGptAuthMethod = (value: string | null | undefined): boolean =>
  value === "chatgpt" || value === "chatgptAuthTokens";

export const live: Layer.Layer<ChatGptDesktop, never, CodexGateway | ElectronNet> = Layer.effect(
  ChatGptDesktop,
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const electron = yield* ElectronNet;

    const readAuth = (includeToken: boolean, refreshToken: boolean) =>
      gateway.requestLocal("getAuthStatus", { includeToken, refreshToken });

    const readToken = Effect.fn("ChatGptDesktop.readToken")(function* (
      input: ChatGptDesktopRequestInput,
      refreshToken: boolean,
    ) {
      const status = yield* readAuth(true, refreshToken);
      const token = typeof status.authToken === "string" ? status.authToken.trim() : "";
      const authMethod = typeof status.authMethod === "string" ? status.authMethod : null;
      if (isChatGptAuthMethod(authMethod) && token.length > 0) return token;
      return yield* new ChatGptDesktopAuthError({
        message: resolveMissingAuthErrorMessage(input),
      });
    });

    const perform = Effect.fn("ChatGptDesktop.perform")(function* (
      input: ChatGptDesktopRequestInput,
      token: string,
    ) {
      const prepared = prepareChatGptDesktopBody(input);
      const headers = buildChatGptDesktopHeaders(
        token,
        { ...input, headers: prepared.headers },
        () => electron.appVersion,
      );
      input.onRequestHeaders?.(headers);
      return yield* electron.fetch(resolveChatGptDesktopRequestUrl(input.baseUrl, input.path), {
        method: input.method,
        headers,
        body: toChatGptDesktopFetchBody(prepared.body),
      });
    });

    return ChatGptDesktop.of({
      authStatus: readAuth,
      authMethod: readAuth(false, false).pipe(
        Effect.map((status) => (typeof status.authMethod === "string" ? status.authMethod : null)),
      ),
      request: (input) =>
        Effect.gen(function* () {
          const token = yield* readToken(input, false);
          const response = yield* perform(input, token);
          if (response.status !== 401 || input.refreshOn401 === false) return response;
          return yield* perform(input, yield* readToken(input, true));
        }),
    });
  }),
);
