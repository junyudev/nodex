import * as Schema from "effect/Schema";
import { isCodexAppServerVersionAtLeast } from "../codex-runtime/CodexAppServerCapabilities";

export class ChatGptBackendAuthError extends Schema.TaggedError<ChatGptBackendAuthError>()(
  "ChatGptBackendAuthError",
  { message: Schema.String },
) {}

export interface ChatGptBackendIdentity {
  readonly accountId: string;
  readonly userId: string;
  readonly isFedramp: boolean;
}

const WorkspaceRouting = Schema.Struct({
  chatgptAccountId: Schema.NonEmptyString,
  backendOrigin: Schema.NonEmptyString,
  accountRoutingOverride: Schema.Literals(["NO_CONSTRAINT", "us", "us_cr"]),
});

// account/read's optional routing extension is not yet in the generated public protocol.
// Keep its validation at this adapter; never infer a route from plan or token presence.
export const AccountRoutingResponse = Schema.Struct({
  account: Schema.NullOr(
    Schema.Struct({
      type: Schema.String,
      planType: Schema.optionalKey(Schema.String),
    }),
  ),
  workspaceRouting: Schema.optionalKey(Schema.NullOr(WorkspaceRouting)),
});
export const RoutingRequirements = Schema.Struct({
  requirements: Schema.NullOr(
    Schema.Struct({
      chatgptBaseUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
      enforceResidency: Schema.optionalKey(Schema.NullOr(Schema.String)),
      application: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ network: Schema.optionalKey(Schema.Unknown) })),
      ),
    }),
  ),
});

export type ChatGptBackendRouting =
  | { readonly kind: "legacy" }
  | { readonly kind: "workspace"; readonly workspace: typeof WorkspaceRouting.Type };

export interface ChatGptBackendRequestAuth {
  readonly signal: AbortSignal;
  readonly token: string;
  readonly identity: ChatGptBackendIdentity;
  readonly routing: ChatGptBackendRouting;
  readonly planType: string | null;
}

export const resolveChatGptBackendRouting = (input: {
  readonly account: unknown;
  readonly requirements: unknown;
  readonly version: string | null;
  readonly identity: ChatGptBackendIdentity;
}): ChatGptBackendRouting => {
  const account = Schema.decodeUnknownSync(AccountRoutingResponse)(input.account);
  const requirements = Schema.decodeUnknownSync(RoutingRequirements)(input.requirements);
  if (account.account?.type !== "chatgpt") {
    throw new ChatGptBackendAuthError({ message: "ChatGPT authentication is unavailable" });
  }
  if (account.workspaceRouting != null) {
    const workspace = account.workspaceRouting;
    const origin = new URL(workspace.backendOrigin);
    if (origin.protocol !== "https:" || origin.origin !== workspace.backendOrigin) {
      throw new ChatGptBackendAuthError({ message: "Invalid workspace backend origin" });
    }
    if (workspace.chatgptAccountId !== input.identity.accountId) {
      throw new ChatGptBackendAuthError({ message: "Authenticated workspace changed" });
    }
    return { kind: "workspace", workspace };
  }
  const constraints = requirements.requirements;
  if (
    account.workspaceRouting === undefined &&
    isCodexAppServerVersionAtLeast(input.version, "0.141.0") &&
    !isCodexAppServerVersionAtLeast(input.version, "0.155.0-alpha.5") &&
    constraints?.chatgptBaseUrl == null &&
    constraints?.enforceResidency == null &&
    constraints?.application?.network == null &&
    !input.identity.isFedramp
  ) {
    return { kind: "legacy" };
  }
  throw new ChatGptBackendAuthError({ message: "Workspace routing is unavailable" });
};

export const routeChatGptBackendRequest = (
  url: string,
  headers: Headers,
  auth: ChatGptBackendRequestAuth,
): string => {
  headers.delete("X-OpenAI-Account-Routing-Override");
  if (auth.identity.isFedramp) headers.set("X-OpenAI-Fedramp", "true");
  else headers.delete("X-OpenAI-Fedramp");
  if (auth.routing.kind === "legacy") return url;
  const { workspace } = auth.routing;
  if (workspace.accountRoutingOverride !== "NO_CONSTRAINT") {
    headers.set("X-OpenAI-Account-Routing-Override", workspace.accountRoutingOverride);
  }
  const original = new URL(url);
  return `${workspace.backendOrigin}${original.pathname}${original.search}`;
};
