import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Effect from "effect/Effect";

/** Native ephemeral login keeps the current account owner separate from restored history. */
export const authenticateCodexClient = Effect.fn("authenticateCodexClient")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  authentication: Effect.Effect<
    ExecutionHost.ProviderAuthentication,
    ExecutionHost.ExecutionHostError
  >,
) {
  const auth = yield* authentication.pipe(
    Effect.mapError(
      () =>
        new CodexErrors.CodexAppServerRequestError({
          code: -32001,
          method: "account/login/start",
          errorMessage: "Configured Codex authentication is unavailable.",
        }),
    ),
  );
  if (auth.kind === "external") return;
  if (auth.kind === "api-key") {
    yield* client.request("account/login/start", { type: "apiKey", apiKey: auth.key });
    return;
  }
  yield* client.request("account/login/start", {
    type: "chatgptAuthTokens",
    accessToken: auth.accessToken,
    chatgptAccountId: auth.accountId,
    chatgptPlanType: auth.planType,
  });
});
