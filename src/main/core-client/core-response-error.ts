import type { components } from "@nodex/core-protocol";

/** Structured Core evidence is shared by HTTP admission and Module responses. */
export class CoreResponseError extends Error {
  constructor(
    message: string,
    readonly coreError?: components["schemas"]["CoreError"],
  ) {
    super(message);
    this.name = "CoreResponseError";
  }
}

export const requiresCoreSessionRenewal = (error: unknown): boolean =>
  error instanceof CoreResponseError && error.coreError?.recovery.kind === "renew_remote_session";
