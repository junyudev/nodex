import { codexSshConnectionFromHostConfig } from "../../shared/codex-ssh-connection";
import { createHash } from "node:crypto";
import type { ThreadReadStateIdentity } from "../../shared/codex-thread-read-state";
import type { CodexSshExecutionHostConfig } from "../../shared/types";

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only stable identity claims leave this decoder; bearer tokens are never retained. */
export function readThreadStateIdentity(status: unknown): ThreadReadStateIdentity | null {
  if (!isRecord(status) || (status.authMethod !== null && typeof status.authMethod !== "string"))
    return null;
  if (status.authMethod !== "chatgpt" && status.authMethod !== "chatgptAuthTokens") {
    if (status.authMethod === null && status.requiresOpenaiAuth !== false) return null;
    return { kind: "execution-storage", authMode: status.authMethod ?? "none" };
  }
  try {
    const segment =
      typeof status.authToken === "string" ? status.authToken.split(".", 3)[1] : undefined;
    if (!segment) return null;
    const payload: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    if (!isRecord(payload) || !Number.isInteger(payload.exp) || (payload.exp as number) <= 0)
      return null;
    const claims = payload["https://api.openai.com/auth"];
    if (!isRecord(claims)) return null;
    for (const field of ["account_id", "chatgpt_account_id", "user_id", "chatgpt_user_id"]) {
      if (
        claims[field] !== undefined &&
        (typeof claims[field] !== "string" || claims[field].length === 0)
      )
        return null;
    }
    const accountId = claims.chatgpt_account_id ?? claims.account_id;
    const userId = claims.user_id ?? claims.chatgpt_user_id;
    if (typeof accountId !== "string" || typeof userId !== "string") return null;
    return { kind: "chatgpt", accountId, userId };
  } catch {
    return null;
  }
}

/** Resolve storage-backed execution identities from the current account/read contract. */
export function readThreadStateIdentityFromAccount(
  response: unknown,
): ThreadReadStateIdentity | null {
  if (!isRecord(response)) return null;
  if (response.account === null) {
    return response.requiresOpenaiAuth === false
      ? { kind: "execution-storage", authMode: "none" }
      : null;
  }
  if (!isRecord(response.account)) return null;
  if (response.account.type === "apiKey") {
    return { kind: "execution-storage", authMode: "apikey" };
  }
  if (response.account.type === "amazonBedrock") {
    return { kind: "execution-storage", authMode: "amazonBedrock" };
  }
  return null;
}

export const threadReadStateIdentityKey = (identity: ThreadReadStateIdentity): string =>
  hash(
    identity.kind === "chatgpt"
      ? [identity.kind, identity.accountId, identity.userId]
      : [identity.kind, identity.authMode],
  );

/** A changed execution endpoint cannot reuse the previous endpoint's read state. */
export const threadReadStateHostKeys = (
  hosts: readonly CodexSshExecutionHostConfig[],
): Record<string, string> => ({
  local: `local:${hash(["local", "local", null])}`,
  ...Object.fromEntries(
    hosts
      .filter((host) => host.enabled)
      .map((host) => [
        host.id,
        `${host.id}:${hash(["ssh", host.id, codexSshConnectionFromHostConfig(host)])}`,
      ]),
  ),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
