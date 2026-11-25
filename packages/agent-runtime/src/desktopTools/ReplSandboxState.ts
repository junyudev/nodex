// @effect-diagnostics nodeBuiltinImport:off -- encodes native paths for the signed REPL transport
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeMode } from "@nodex/runtime-contracts";

export interface ReplExecutionPolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly writableRoots: readonly string[];
}

/**
 * Codex 0.171 sandbox-state transport, as advertised by the pinned node_repl.
 * Keep the native permission profile encoding at this boundary.
 */
export function replSandboxMetadata(
  policy: ReplExecutionPolicy,
  cwd: string,
  scratchRoot: string,
  codexExecutable: string | undefined,
) {
  const permissionProfile =
    policy.runtimeMode === "full-access"
      ? { type: "disabled" }
      : {
          type: "managed",
          file_system: {
            type: "restricted",
            entries: [
              { path: { type: "special", value: { kind: "root" } }, access: "read" },
              ...[...new Set([...policy.writableRoots, scratchRoot])].map((path) => ({
                path: { type: "path", path },
                access: "write",
              })),
            ],
          },
          network: "restricted",
        };
  const state = {
    permissionProfile,
    sandboxCwd: pathToFileURL(cwd).href,
    codexLinuxSandboxExe: null,
    useLegacyLandlock: false,
    useMxc: false,
  };
  return {
    "codex/sandbox-state": state,
    "codex/sandbox-state-meta": state,
    ...(codexExecutable && isAbsolute(codexExecutable)
      ? { "codex/sandbox-launcher": { codexExecutable } }
      : {}),
  };
}
