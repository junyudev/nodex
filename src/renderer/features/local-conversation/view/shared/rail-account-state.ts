import type { CodexAccountSnapshot, CodexConnectionState } from "@/lib/types";

/** What the rail's account slot shows; it is never empty. */
export type RailAccountState =
  | { readonly kind: "signedIn" }
  | { readonly kind: "signedOut" }
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The account slot follows what Nodex knows about the Codex account. A known account shows its
 * usage, a known signed-out state offers sign-in, and anything still unknown says whether it is
 * loading or why it cannot load yet.
 */
export function resolveRailAccountState(
  account: CodexAccountSnapshot | null,
  connection: CodexConnectionState | undefined,
): RailAccountState {
  if (account?.account) return { kind: "signedIn" };
  if (connection?.error?.code === "login-required" || account?.status === "ready")
    return { kind: "signedOut" };
  if (connection?.status === "missingBinary")
    return { kind: "unavailable", reason: "Codex is not installed" };
  if (connection?.status === "error")
    return { kind: "unavailable", reason: connection.message ?? "Codex could not start" };
  if (connection?.status === "disconnected" && connection.lastConnectedAt !== undefined)
    return { kind: "unavailable", reason: "Codex disconnected" };
  if (account?.status === "unavailable")
    return { kind: "unavailable", reason: "Can't reach your Codex account" };
  return { kind: "loading" };
}
