/* @effect-diagnostics asyncFunction:off -- Host permission admission is a Node Adapter boundary. */
import { lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { AgentRunner } from "../../../host/HostAgentPolicy";
import { verifyPrivatePaths } from "./private-filesystem";

/** Credential hashes live in the Store, so its files are administration secrets too. */
export async function verifyHostSecrets(
  coreHome: string,
  coreExecutable: string,
  options: { readonly running?: boolean } = {},
): Promise<void> {
  const entries = [
    { path: coreHome, directory: true },
    { path: join(coreHome, "nodex.db"), directory: false },
    { path: join(coreHome, "run", "core"), directory: true },
    { path: join(coreHome, "team-transport"), directory: true },
    { path: join(coreHome, "team-transport", "server-identity.pem"), directory: false },
  ];
  const auth = join(coreHome, "run/core/core.auth");
  if (options.running !== false) entries.push({ path: auth, directory: false });
  const optional = [
    "nodex.db-wal",
    "nodex.db-shm",
    "host.json",
    "settings.key",
    "config.toml",
    "run/host.json",
    "run/host.lock",
  ];
  if (options.running === false) optional.push("run/core/core.auth");
  for (const relative of optional) {
    const path = join(coreHome, relative);
    const metadata = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (metadata) entries.push({ path, directory: false });
  }
  await verifyPrivatePaths(entries, coreExecutable);
}

/** Bind a numeric address so DNS cannot change a loopback decision after admission. */
export function hostListenerWarning(input: {
  readonly address: string;
  readonly agentRunner?: AgentRunner;
  readonly allowSameUserAgents: boolean;
}): string | null {
  const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(input.address);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Host listening address must be a numeric IP address and port");
  const loopback = host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (input.agentRunner) return null;
  if (!loopback && !input.allowSameUserAgents)
    throw new Error("Listening beyond loopback requires agentRunner or --allow-same-user-agents");
  return "Agents run as the host user and can access that user's private files. Use a separate Agent Runner for OS isolation.";
}
