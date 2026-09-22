import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import {
  AccountRoutingResponse,
  ChatGptBackendAuthError,
  resolveChatGptBackendRouting,
  type ChatGptBackendIdentity,
  type ChatGptBackendRequestAuth,
} from "./chatgpt-backend-routing";
export {
  ChatGptBackendAuthError,
  resolveChatGptBackendRouting,
  routeChatGptBackendRequest,
  type ChatGptBackendIdentity,
  type ChatGptBackendRequestAuth,
  type ChatGptBackendRouting,
} from "./chatgpt-backend-routing";

const Claims = Schema.Struct({
  exp: Schema.Number,
  "https://api.openai.com/auth": Schema.Struct({
    account_id: Schema.optionalKey(Schema.NonEmptyString),
    chatgpt_account_id: Schema.optionalKey(Schema.NonEmptyString),
    user_id: Schema.optionalKey(Schema.NonEmptyString),
    chatgpt_user_id: Schema.optionalKey(Schema.NonEmptyString),
    chatgpt_account_is_fedramp: Schema.optionalKey(Schema.Boolean),
  }),
});

export const decodeChatGptBackendIdentity = (token: string): ChatGptBackendIdentity | null => {
  try {
    const payload = Buffer.from(token.split(".", 3)[1] ?? "", "base64url").toString("utf8");
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(Claims))(payload);
    const claims = decoded["https://api.openai.com/auth"];
    const accountId = claims.chatgpt_account_id ?? claims.account_id;
    const userId = claims.user_id ?? claims.chatgpt_user_id;
    if (!accountId || !userId || !Number.isInteger(decoded.exp) || decoded.exp <= 0) return null;
    return { accountId, userId, isFedramp: claims.chatgpt_account_is_fedramp === true };
  } catch {
    return null;
  }
};

export const readChatGptBackendRequestAuth = Effect.fn("ChatGptDesktop.readBackendRequestAuth")(
  function* (gateway: CodexGateway["Service"], refreshToken = false) {
    const authState = yield* CodexExecutionHostAuthState;
    const signal = yield* authState.backendLease(gateway.localHostId);
    const capabilities = yield* CodexAppServerCapabilities;
    const version = yield* capabilities.forHost(gateway.localHostId);
    const status = yield* gateway.requestLocal("getAuthStatus", {
      includeToken: true,
      refreshToken,
    });
    const token = status.authToken;
    const identity = typeof token === "string" ? decodeChatGptBackendIdentity(token) : null;
    if (
      (status.authMethod !== "chatgpt" && status.authMethod !== "chatgptAuthTokens") ||
      !token ||
      !identity
    ) {
      return yield* new ChatGptBackendAuthError({
        message: "ChatGPT authentication is unavailable",
      });
    }
    const [account, requirements] = yield* Effect.all([
      gateway.requestRawOnHost(gateway.localHostId, "account/read", { refreshToken: false }),
      gateway.requestRawOnHost(gateway.localHostId, "configRequirements/read", {}),
    ]);
    const decodedAccount = yield* Schema.decodeUnknownEffect(AccountRoutingResponse)(account).pipe(
      Effect.mapError(() => new ChatGptBackendAuthError({ message: "Invalid account response" })),
    );
    // The verified public 0.155.0 binary omits this extension, while the bundled companion
    // implements it. An explicit null, invalid value or refusal must never enter this path.
    const needsCompanion =
      version.version === "0.155.0" &&
      decodedAccount.account?.type === "chatgpt" &&
      decodedAccount.workspaceRouting === undefined;
    const companion = yield* CodexWorkspaceRouting;
    const routing = needsCompanion
      ? yield* companion
          .discover({
            token,
            identity,
            primaryHost: version,
            requirements,
            signal,
          })
          .pipe(Effect.mapError((error) => new ChatGptBackendAuthError({ message: error.message })))
      : yield* Effect.try({
          try: () =>
            resolveChatGptBackendRouting({
              account,
              requirements,
              version: version.version,
              identity,
            }),
          catch: () => new ChatGptBackendAuthError({ message: "Workspace routing is unavailable" }),
        });
    if (needsCompanion) {
      const currentRequirements = yield* gateway.requestRawOnHost(
        gateway.localHostId,
        "configRequirements/read",
        {},
      );
      if (JSON.stringify(currentRequirements) !== JSON.stringify(requirements)) {
        return yield* new ChatGptBackendAuthError({ message: "Workspace requirements changed" });
      }
    }
    const current = yield* gateway.requestLocal("getAuthStatus", {
      includeToken: true,
      refreshToken: false,
    });
    const currentIdentity = current.authToken
      ? decodeChatGptBackendIdentity(current.authToken)
      : null;
    if (
      signal.aborted ||
      !(yield* capabilities.isCurrent(version)) ||
      currentIdentity?.accountId !== identity.accountId ||
      currentIdentity.userId !== identity.userId
    ) {
      return yield* new ChatGptBackendAuthError({ message: "Authenticated workspace changed" });
    }
    return {
      signal,
      token,
      identity,
      routing,
      planType: decodedAccount.account?.planType ?? null,
    } satisfies ChatGptBackendRequestAuth;
  },
);
