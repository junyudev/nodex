import { expect, it } from "vite-plus/test";
import type { SandboxPolicy } from "@nodex/codex-app-server-protocol/v2/SandboxPolicy";
import { isNodexAgentTurnReadOnly } from "./nodex-agent-access";

it("keeps Plan read-only even with full access and rejects unproven sandbox policy", () => {
  const policies: Array<[SandboxPolicy | null, boolean]> = [
    [{ type: "dangerFullAccess" }, false],
    [
      {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      false,
    ],
    [{ type: "readOnly", networkAccess: false }, true],
    [{ type: "externalSandbox", networkAccess: "restricted" }, true],
    [null, true],
  ];
  for (const [sandboxPolicy, readOnly] of policies) {
    expect(isNodexAgentTurnReadOnly({ sandboxPolicy, planMode: false })).toBe(readOnly);
    expect(isNodexAgentTurnReadOnly({ sandboxPolicy, planMode: true })).toBe(true);
  }
});
