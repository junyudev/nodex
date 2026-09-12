import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";

export interface CodexNativeFreshLaunchAdoption {
  readonly hostId: string;
  readonly generation: number;
  readonly response: ThreadStartResponse;
}

export interface CodexNativeSessionLaunchPreparation {
  readonly receiptId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly request: import("@nodex/codex-app-server-protocol/v2").ThreadStartParams;
}
