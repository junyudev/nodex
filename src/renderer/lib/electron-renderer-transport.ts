import type { CodexEvent } from "./types";
import type { BoardChangeEvent } from "../../shared/ipc-api";

export type ElectronRendererBridge = NonNullable<Window["api"]>;

export function createElectronRendererTransport(bridge: ElectronRendererBridge) {
  return {
    kind: "electron" as const,
    invoke(channel: string, ...args: unknown[]) {
      return bridge.invoke(channel, ...args);
    },
    subscribeBoardChanges(projectId: string, callback: () => void) {
      return bridge.on("board-changed", (...args: unknown[]) => {
        const payload = args[0] as BoardChangeEvent | undefined;
        if (!payload || payload.projectId !== projectId) return;
        callback();
      });
    },
    subscribeCodexEvents(callback: (event: CodexEvent) => void) {
      return bridge.on("codex:event", (...args: unknown[]) => {
        const payload = args[0] as CodexEvent | undefined;
        if (!payload) return;
        callback(payload);
      });
    },
    subscribeGitBranchChanges(callback: (event: { cwd: string }) => void) {
      return bridge.on("git:branch:changed", (...args: unknown[]) => {
        const payload = args[0] as { cwd?: string } | undefined;
        if (!payload || typeof payload.cwd !== "string") return;
        callback({ cwd: payload.cwd });
      });
    },
  };
}
