import type {
  ProviderAuthState,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderAuthCompleteInput,
  ProviderAuthCancelInput,
} from "@nodex/runtime-contracts";
import type { AgentWire } from "./Interface.ts";

export interface AgentProviderAuthentication extends AgentWire<ProviderAuthState> {
  readonly runtimeGeneration: string;
  readonly configurationRevision: number;
  readonly revision: number;
  readonly cancellable: boolean;
}

type Target = { readonly instanceId: string };
type Owner = { readonly ownerId: string };

/** Provider-owned setup; browser navigation and persistence of configuration belong to the Host. */
export interface AgentProviderManagementOperations {
  readonly "providers.auth.read": {
    readonly input: Target & Owner;
    readonly output: AgentProviderAuthentication;
  };
  readonly "providers.auth.start": {
    readonly input: AgentWire<ProviderAuthStartInput> & Owner;
    readonly output: AgentProviderAuthentication;
  };
  readonly "providers.auth.respond": {
    readonly input: AgentWire<ProviderAuthRespondInput> & Owner;
    readonly output: AgentProviderAuthentication;
  };
  readonly "providers.auth.complete": {
    readonly input: AgentWire<ProviderAuthCompleteInput> & Owner;
    readonly output: AgentProviderAuthentication;
  };
  readonly "providers.auth.cancel": {
    readonly input: AgentWire<ProviderAuthCancelInput> & Owner;
    readonly output: AgentProviderAuthentication;
  };
  readonly "providers.auth.logout": {
    readonly input: Target;
    readonly output: AgentProviderAuthentication;
  };
  readonly "providers.usage.scan": {
    readonly input: Target & { readonly sinceMs: number; readonly untilMs: number };
    readonly output: AgentWire<
      ReadonlyArray<import("@nodex/provider-core/server/usage").ProviderUsageScan>
    >;
  };
  readonly "providers.models.refresh": { readonly input: Target; readonly output: null };
}
