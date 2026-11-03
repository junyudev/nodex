import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useTerminal } from "./use-terminal";

vi.mock("./file-reference-router", () => ({ useFileReferenceRouter: () => ({ hostId: "local" }) }));
vi.mock("./web-link-navigation", () => ({ useLinkOpening: () => null }));
vi.mock("./terminal-session-store", () => ({
  isTerminalRuntimeAvailable: () => false,
  terminalSessionStore: {
    getSnapshot: (id: string) => ({
      exited: id === "exited",
      exitCode: id === "exited" ? 7 : null,
    }),
    getError: (id: string) => (id === "exited" ? "Disconnected" : null),
    getLeaseConflict: () => null,
  },
}));

test("seeds each Terminal identity from its own snapshot, including hidden Terminals", () => {
  const { result, rerender } = renderHook(
    ({ terminalId }) => useTerminal({ terminalId, cwd: "/workspace", visible: false }),
    { initialProps: { terminalId: "exited" }, wrapper: StrictMode },
  );
  expect(result.current.isExited).toBe(true);
  expect(result.current.exitCode).toBe(7);
  expect(result.current.error).toBe("Disconnected");
  rerender({ terminalId: "running" });
  expect(result.current.isExited).toBe(false);
  expect(result.current.exitCode).toBeNull();
  expect(result.current.error).toBeNull();
});
