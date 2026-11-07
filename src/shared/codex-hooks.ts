import type { HooksListResponse } from "@nodex/codex-app-server-protocol/v2";
export type CodexHooksListResponse = HooksListResponse;

export interface CodexHooksListInput {
  hostId: string;
  cwds: string[];
}

interface CodexHookStatePatchBase {
  key: string;
}

export type CodexHookStatePatch =
  | (CodexHookStatePatchBase & {
      enabled: boolean;
      trustedHash?: string;
    })
  | (CodexHookStatePatchBase & {
      enabled?: boolean;
      trustedHash: string;
    });

export interface CodexHooksStateUpdateInput {
  hostId: string;
  patches: CodexHookStatePatch[];
}

export interface CodexHooksChangedEvent {
  hostId: string;
}
