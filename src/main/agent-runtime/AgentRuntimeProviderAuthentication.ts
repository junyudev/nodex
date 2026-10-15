import type { AgentProviderAuthentication } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decodeChatGptBackendIdentity } from "../codex/chatgpt-backend-auth";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";

export class AgentRuntimeAuthenticationError extends Schema.TaggedError<AgentRuntimeAuthenticationError>()(
  "AgentRuntimeAuthenticationError",
  { message: Schema.String },
) {}
const unavailable = () =>
  new AgentRuntimeAuthenticationError({
    message: "Sign in to the configured Codex account before resuming this Session",
  });

/** Restored native history borrows current account credentials without copying its account store. */
export const make = Effect.fn("AgentRuntimeProviderAuthentication.make")(function* () {
  const gateway = yield* CodexGateway;
  const accounts = yield* CodexExecutionHostAuthState;
  return Effect.fn("AgentRuntimeProviderAuthentication.read")(function* (input: {
    readonly refresh: boolean;
    readonly previousAccountId: string | null;
    readonly isActive: () => boolean;
  }): Effect.fn.Return<AgentProviderAuthentication, AgentRuntimeAuthenticationError> {
    if (!input.isActive()) return yield* unavailable();
    const lease = yield* accounts.backendLease(gateway.localHostId);
    const status = yield* gateway
      .requestLocal("getAuthStatus", {
        includeToken: true,
        refreshToken: input.refresh,
      })
      .pipe(Effect.mapError(() => unavailable()));
    if (lease.aborted || !input.isActive()) return yield* unavailable();
    if (status.requiresOpenaiAuth === false) return { kind: "external" };
    const token = status.authToken?.trim();
    if (!token) return yield* unavailable();
    if (status.authMethod === "apikey" && input.previousAccountId === null)
      return { kind: "api-key", key: token };
    const identity = decodeChatGptBackendIdentity(token);
    if (
      (status.authMethod !== "chatgpt" && status.authMethod !== "chatgptAuthTokens") ||
      !identity ||
      (input.previousAccountId !== null && input.previousAccountId !== identity.accountId)
    )
      return yield* unavailable();
    return { kind: "chatgpt", accessToken: token, accountId: identity.accountId, planType: null };
  });
});
