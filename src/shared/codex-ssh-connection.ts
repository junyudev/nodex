import type { CodexSshExecutionHostConfig } from "./types";

/** Stable physical endpoint identity shared by SSH transport and read-state sessions. */
export interface CodexSshConnectionIdentity {
  readonly sshAlias: string | null;
  readonly sshHost: string;
  readonly sshPort: number | null;
  readonly identity: string | null;
}

export function codexSshConnectionFromHostConfig(
  host: Pick<CodexSshExecutionHostConfig, "sshAlias" | "port">,
): CodexSshConnectionIdentity {
  return {
    sshAlias: host.port === null ? host.sshAlias : null,
    sshHost: host.sshAlias,
    sshPort: host.port,
    identity: null,
  };
}
