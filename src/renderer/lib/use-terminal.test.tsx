import { StrictMode, type PropsWithChildren } from "react";
import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { useTerminal } from "./use-terminal";
import { TestQueryProvider } from "../test/query";

vi.mock("./file-reference-router", () => ({ useFileReferenceRouter: () => ({ hostId: "local" }) }));
vi.mock("./web-link-navigation", () => ({ useLinkOpening: () => null }));
vi.mock("./terminal-session-store", () => ({
  isTerminalRuntimeAvailable: () => false,
  terminalSessionStore: {
    subscribeAll: () => () => {},
    getError: (id: string) => (id === "exited" ? "Disconnected" : null),
    getLeaseConflict: () => null,
  },
}));

test("reads each terminal identity’s attachment error", () => {
  const { result, rerender } = renderHook(
    ({ terminalId }) => useTerminal({ terminalId, cwd: "/workspace" }),
    {
      initialProps: { terminalId: "exited" },
      wrapper: ({ children }: PropsWithChildren) => (
        <StrictMode>
          <TestQueryProvider>{children}</TestQueryProvider>
        </StrictMode>
      ),
    },
  );
  expect(result.current.error).toBe("Disconnected");
  rerender({ terminalId: "running" });
  expect(result.current.error).toBeNull();
});
