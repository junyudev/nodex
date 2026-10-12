import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createPendingArtifactRecovery,
  type PendingArtifactRecoveryRead,
} from "../local-conversation-pending-artifact-recovery";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryBoundaryRef,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  PendingArtifactRecoveryStatus,
  LocalConversationPendingArtifact,
} from "./local-conversation-pending-artifact";

const fixture = vi.hoisted(() => ({ getForHostId: vi.fn(), getPendingArtifactRecovery: vi.fn() }));
vi.mock("../local-conversation-store", () => ({
  useCodexAppServerRegistry: () => ({ getForHostId: fixture.getForHostId }),
}));
afterEach(cleanup);

function boundary(cursor: string) {
  const value = availableCodexHistoryBoundary("tail:older", {
    source: "timeline",
    cursor,
    oldestLoadedTurnId: "one",
  });
  if (value.status !== "available") throw new Error("Invalid test boundary");
  return value;
}

function snapshot(cursor: string | null): PendingArtifactRecoveryRead {
  return {
    missingReceiptIds: ["receipt"],
    olderPage:
      cursor === null
        ? null
        : {
            threadId: "thread",
            expectedConversationGeneration: 0,
            expectedHistoryMutationRevision: 0,
            target: {
              kind: "turnBoundary",
              boundary: createCodexHistoryBoundaryRef(0, "tail", "older", boundary(cursor)),
            },
          },
  };
}

test("retry shows progress, blocks duplicate input, and removes the action after history is exhausted", async () => {
  let current = snapshot("older");
  let finish: (() => void) | undefined;
  const loadOlder = vi.fn(
    () =>
      new Promise<{ status: "applied" }>((resolve) => {
        finish = () => resolve({ status: "applied" });
      }),
  );
  const recovery = createPendingArtifactRecovery({
    read: () => current,
    supportsTimeline: () => true,
    loadOlder,
  });
  try {
    render(<PendingArtifactRecoveryStatus recovery={recovery} />);
    expect(screen.getByRole("status").textContent).toContain("Artifact not available yet");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Load older history" }).hasAttribute("disabled"),
      ).toBe(true),
    );
    expect(screen.getByRole("status").textContent).toContain("Loading artifact…");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
      await Promise.resolve();
    });
    expect(loadOlder).toHaveBeenCalledTimes(1);
    await act(async () => {
      current = snapshot(null);
      finish?.();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load older history" })).toBeNull(),
    );
    expect(screen.getByRole("status").textContent).toContain("Artifact not available yet");
  } finally {
    recovery.dispose();
  }
});

test("a failed automatic attempt exposes the same explicit retry action", async () => {
  let current = snapshot("older");
  const loadOlder = vi.fn(async () => ({ status: "applied" as const }));
  loadOlder.mockRejectedValueOnce(new Error("offline"));
  const recovery = createPendingArtifactRecovery({
    read: () => current,
    supportsTimeline: () => true,
    loadOlder,
  });
  try {
    render(<PendingArtifactRecoveryStatus recovery={recovery} />);
    await act(async () => {
      await recovery.hydrate();
    });
    expect(screen.getByRole("status").textContent).toContain("Couldn’t load artifact");
    loadOlder.mockImplementation(async () => {
      current = snapshot(null);
      return { status: "applied" };
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load older history" })).toBeNull(),
    );
    expect(loadOlder).toHaveBeenCalledTimes(2);
  } finally {
    recovery.dispose();
  }
});

test("the pending leaf routes retry to the transcript's exact host and Thread owner", async () => {
  const recovery = createPendingArtifactRecovery({
    read: () => snapshot(null),
    supportsTimeline: () => true,
    loadOlder: async () => ({ status: "applied" }),
  });
  fixture.getForHostId.mockReturnValue({
    getPendingArtifactRecovery: fixture.getPendingArtifactRecovery,
  });
  fixture.getPendingArtifactRecovery.mockReturnValue(recovery);
  try {
    render(
      <LocalConversationPendingArtifact
        ownerKey={{ hostId: "remote-host", threadId: "same-thread-id" }}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Load older history" })).toBeNull(),
    );
    expect(fixture.getForHostId).toHaveBeenCalledWith("remote-host");
    expect(fixture.getPendingArtifactRecovery).toHaveBeenCalledWith("same-thread-id");
  } finally {
    recovery.dispose();
  }
});
