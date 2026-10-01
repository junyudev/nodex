import * as Schema from "effect/Schema";
import type { ApplicationNetworkRequirements } from "@nodex/codex-app-server-protocol/v2/ApplicationNetworkRequirements";
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
const NetworkDomain = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  ),
);
const NetworkRequirements = Schema.Struct({
  enabled: Schema.Boolean,
  // Record key filters select matching properties rather than reject malformed keys.
  // Validate every domain explicitly so malformed policy cannot become unrestricted.
  domains: Schema.Record(Schema.String, Schema.Literals(["allow", "deny"])).check(
    Schema.makeFilter((domains) => Object.keys(domains).every(Schema.is(NetworkDomain))),
  ),
});
export const RoutingRequirements = Schema.Struct({
  requirements: Schema.NullOr(
    Schema.Struct({
      chatgptBaseUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
      enforceResidency: Schema.optionalKey(Schema.NullOr(Schema.String)),
      application: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ network: Schema.NullOr(NetworkRequirements) })),
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
  readonly network: ApplicationNetworkRequirements | null;
}

const decodeRoutingRequirements = (requirements: unknown, version: string | null) => {
  const decoded = Schema.decodeUnknownSync(RoutingRequirements)(requirements);
  const legacyVersion =
    isCodexAppServerVersionAtLeast(version, "0.141.0") &&
    !isCodexAppServerVersionAtLeast(version, "0.155.0-alpha.5");
  if (
    decoded.requirements !== null &&
    decoded.requirements.application === undefined &&
    !legacyVersion
  ) {
    throw new ChatGptBackendAuthError({
      message: "Application network requirements are unavailable",
    });
  }
  return decoded;
};

/** Null explicitly permits unrestricted requests; unavailable or malformed policy never does. */
export const resolveChatGptApplicationNetwork = (input: {
  readonly requirements: unknown;
  readonly version: string | null;
}): ApplicationNetworkRequirements | null =>
  decodeRoutingRequirements(input.requirements, input.version).requirements?.application?.network ??
  null;

export const resolveChatGptBackendRouting = (input: {
  readonly account: unknown;
  readonly requirements: unknown;
  readonly version: string | null;
  readonly identity: ChatGptBackendIdentity;
}): ChatGptBackendRouting => {
  const account = Schema.decodeUnknownSync(AccountRoutingResponse)(input.account);
  const requirements = decodeRoutingRequirements(input.requirements, input.version);
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
  const original = new URL(url);
  const routed =
    auth.routing.kind === "legacy"
      ? original
      : new URL(`${auth.routing.workspace.backendOrigin}${original.pathname}${original.search}`);
  if (auth.network === undefined) {
    throw new ChatGptBackendAuthError({
      message: "Application network requirements are unavailable",
    });
  }
  if (
    auth.network?.enabled === true &&
    ((routed.protocol !== "https:" && routed.protocol !== "wss:") ||
      auth.network.domains[routed.hostname.replace(/\.$/u, "")] !== "allow")
  ) {
    throw new ChatGptBackendAuthError({
      message: "Desktop network policy does not allow this destination",
    });
  }
  headers.delete("X-OpenAI-Account-Routing-Override");
  if (auth.identity.isFedramp) headers.set("X-OpenAI-Fedramp", "true");
  else headers.delete("X-OpenAI-Fedramp");
  if (auth.routing.kind === "legacy") return url;
  const { workspace } = auth.routing;
  if (workspace.accountRoutingOverride !== "NO_CONSTRAINT") {
    headers.set("X-OpenAI-Account-Routing-Override", workspace.accountRoutingOverride);
  }
  return routed.toString();
};
