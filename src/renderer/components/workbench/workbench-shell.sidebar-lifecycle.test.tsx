import "./workbench-testkit/workbench-shell-harness";
import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { __getNodexToastSnapshotForTests } from "@/components/ui/toast";
import { settleAsyncRender } from "../../test/dom";
import {
  fixtureSessionActivityAt,
  makeAttachedSession,
  makeProject,
  makeSession,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  getMountedSessionIds,
  getSidebarSection,
  getThreadRow,
  invokeCalls,
  replyPreviewReads,
  rendererCommandPayload,
  renderWorkbench,
  selectSidebarSession,
  markConversationAsReadCalls,
  setInboxCountsForTest,
  setReplyPreviewsForTest,
  setSidebarOrganizeForTest,
} from "./workbench-testkit/workbench-shell-harness";

function chat(
  title: string,
  overrides: Parameters<typeof makeAttachedSession>[0] = {},
): ReturnType<typeof makeAttachedSession> {
  const projectId = overrides.projectId === undefined ? "alpha" : overrides.projectId;
  const slug = title.toLowerCase().replaceAll(" ", "-");
  return makeAttachedSession({
    id: `session:${projectId ?? "projectless"}:${slug}`,
    threadId: `thread-${slug}`,
    title,
    rightCollapsed: true,
    tabs: [],
    ...overrides,
  });
}

function laneTitles(container: HTMLElement, heading: string): string[] {
  return Array.from(
    getSidebarSection(container, heading).querySelectorAll("[data-app-action-sidebar-thread-row]"),
  ).map((row) => row.getAttribute("data-app-action-sidebar-thread-title") ?? "");
}

/** Opens the view options beside the attention arrangement's first heading. */
async function openViewOptions(container: HTMLElement) {
  await act(async () => {
    const trigger = within(container).getByRole("button", { name: "View options" });
    fireEvent.pointerDown(trigger, { button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  await settleAsyncRender();
}

async function renderSettled(input: Parameters<typeof renderWorkbench>[0]) {
  const screen = renderWorkbench(input);
  await settleAsyncRender();
  await settleAsyncRender();
  return screen;
}

async function pressSettle(container: HTMLElement, title: string, name = "Settle") {
  await act(async () => {
    fireEvent.click(within(getThreadRow(container, title)).getByRole("button", { name }));
    await Promise.resolve();
  });
  await settleAsyncRender();
  await settleAsyncRender();
}

const setSettledCalls = (sessionId: string) =>
  invokeCalls
    .filter(
      (call) =>
        call[0] === "project-sessions:set-settled" &&
        (rendererCommandPayload(call)?.sessionIds as string[] | undefined)?.includes(sessionId),
    )
    .map((call) => rendererCommandPayload(call)?.settled);

const settledToast = () => {
  const record = __getNodexToastSnapshotForTests().find((item) => item.title === "Settled");
  if (!record) throw new Error("Expected the settled toast.");
  return record;
};

describe("workbench session shell / chat lifecycle", () => {
  test("arranged by attention, every Project's chats share lanes by whose move it is", async () => {
    setSidebarOrganizeForTest("attention");
    const screen = await renderSettled({
      projects: [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")],
      sessionsByProject: {
        alpha: [
          makeSession(),
          chat("Came back earlier", { activityAt: fixtureSessionActivityAt(3) }),
          // A native Thread carries its own status; Runtime chats read theirs from live activity.
          chat("Agent is working", {
            activityAt: fixtureSessionActivityAt(0),
            executionRef: null,
            thread: {
              ...chat("Agent is working").thread!,
              statusType: "active",
              statusActiveFlags: [],
            },
          }),
        ],
        beta: [
          chat("Came back last", { projectId: "beta", activityAt: fixtureSessionActivityAt(1) }),
          chat("Stopped on you", {
            projectId: "beta",
            // The oldest of them still leads: its Agent cannot go on until it is answered.
            activityAt: fixtureSessionActivityAt(9),
            executionRef: null,
            thread: {
              ...chat("Stopped on you", { projectId: "beta" }).thread!,
              statusType: "active",
              statusActiveFlags: ["waitingOnUserInput"],
            },
          }),
        ],
      },
      projectlessSessions: [
        chat("Loose chat", { projectId: null, activityAt: fixtureSessionActivityAt(2) }),
      ],
    });

    await waitFor(() =>
      expect(laneTitles(screen.container, "Active")).toEqual([
        "Stopped on you",
        "Came back last",
        "Loose chat",
        "Came back earlier",
      ]),
    );
    expect(laneTitles(screen.container, "Pinned")).toEqual(["Database View"]);
    expect(laneTitles(screen.container, "Working")).toEqual(["Agent is working"]);

    // Each row names where its chat belongs, since the lane spans Projects.
    expect(
      getThreadRow(screen.container, "Came back last").querySelector(
        "[data-app-action-sidebar-thread-trailing-label]",
      )?.textContent,
    ).toBe("Beta");
    expect(
      getThreadRow(screen.container, "Loose chat").querySelector(
        "[data-app-action-sidebar-thread-trailing-label]",
      ),
    ).toBeNull();

    // Projects stay as places to open; their chats already sit in the lanes above.
    const projects = getSidebarSection(screen.container, "Projects");
    expect(within(projects).getByRole("button", { name: "Open Beta" })).not.toBeNull();
    expect(projects.querySelector("[data-app-action-sidebar-thread-row]")).toBeNull();
    expect(within(projects).queryByRole("button", { name: "Expand project" })).toBeNull();

    // The view options sit beside the first heading and leave lists out until shown again.
    expect(
      within(getSidebarSection(screen.container, "Pinned")).getByRole("button", {
        name: "View options",
      }),
    ).toBeTruthy();
    await openViewOptions(screen.container);
    const working = await waitFor(() => screen.getByRole("menuitemcheckbox", { name: "Working" }));
    expect(working.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(working);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await waitFor(() =>
      expect(
        screen.container.querySelector('[data-app-action-sidebar-section-heading="Working"]'),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Working" }).getAttribute("aria-checked"),
    ).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Show everything" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await waitFor(() =>
      expect(laneTitles(screen.container, "Working")).toEqual(["Agent is working"]),
    );
  });

  test("arranged by attention, each row says what came back under its title", async () => {
    setSidebarOrganizeForTest("attention");
    const answered = chat("Answered", { activityAt: fixtureSessionActivityAt(1) });
    const quiet = chat("Never answered", { activityAt: fixtureSessionActivityAt(2) });
    setReplyPreviewsForTest({ [answered.id]: "Fixed the race and added a regression test." });
    const screen = await renderSettled({ sessionsByProject: { alpha: [answered, quiet] } });

    await waitFor(() =>
      expect(
        getThreadRow(screen.container, "Answered").querySelector(
          "[data-app-action-sidebar-thread-preview]",
        )?.textContent,
      ).toBe("Fixed the race and added a regression test."),
    );
    // A chat with nothing to say keeps a one-line row.
    expect(
      getThreadRow(screen.container, "Never answered").querySelector(
        "[data-app-action-sidebar-thread-preview]",
      ),
    ).toBeNull();
    // The rows a list shows ask for their replies together.
    expect(replyPreviewReads).toHaveLength(1);
    expect([...replyPreviewReads[0]!].sort()).toEqual([answered.id, quiet.id].sort());
  });

  test("grouped by Project, rows stay one line", async () => {
    const answered = chat("Answered");
    setReplyPreviewsForTest({ [answered.id]: "Fixed the race." });
    const screen = await renderSettled({ sessionsByProject: { alpha: [answered] } });

    await waitFor(() => expect(getThreadRow(screen.container, "Answered")).not.toBeNull());
    expect(
      getThreadRow(screen.container, "Answered").querySelector(
        "[data-app-action-sidebar-thread-preview]",
      ),
    ).toBeNull();
    expect(replyPreviewReads).toEqual([]);
  });

  test("a snoozed chat waits in Snoozed, which stays folded until opened", async () => {
    setSidebarOrganizeForTest("attention");
    const screen = await renderSettled({
      sessionsByProject: {
        alpha: [chat("Come back to this", { snoozedUntil: "2999-01-01T09:00:00.000Z" })],
      },
    });

    const snoozed = await waitFor(() => getSidebarSection(screen.container, "Snoozed"));
    expect(snoozed.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("true");
    expect(laneTitles(screen.container, "Active")).toEqual([]);
    expect(
      within(getSidebarSection(screen.container, "Active")).getByText("Nothing is waiting on you"),
    ).not.toBeNull();

    await act(async () => {
      fireEvent.click(within(snoozed).getByRole("button", { name: /Snoozed/ }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(laneTitles(screen.container, "Snoozed")).toEqual(["Come back to this"]),
    );
  });

  test("settling a chat takes it out of its lane, and Undo returns it to its place", async () => {
    setSidebarOrganizeForTest("attention");
    const first = chat("First", { activityAt: fixtureSessionActivityAt(1) });
    const second = chat("Second", { activityAt: fixtureSessionActivityAt(2) });
    const third = chat("Third", { activityAt: fixtureSessionActivityAt(3) });
    const screen = await renderSettled({ sessionsByProject: { alpha: [first, second, third] } });
    await waitFor(() =>
      expect(laneTitles(screen.container, "Active")).toEqual(["First", "Second", "Third"]),
    );

    await pressSettle(screen.container, "Second");

    expect(setSettledCalls(second.id)).toEqual([true]);
    await waitFor(() => expect(laneTitles(screen.container, "Active")).toEqual(["First", "Third"]));
    expect(settledToast().action?.label).toBe("Undo");

    await act(async () => {
      settledToast().action?.onClick();
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    expect(setSettledCalls(second.id)).toEqual([true, false]);
    await waitFor(() =>
      expect(laneTitles(screen.container, "Active")).toEqual(["First", "Second", "Third"]),
    );
  });

  test("finishing the chat on screen moves on to the one that takes its place", async () => {
    setSidebarOrganizeForTest("attention");
    const first = chat("First", { activityAt: fixtureSessionActivityAt(1) });
    const second = chat("Second", { activityAt: fixtureSessionActivityAt(2) });
    const third = chat("Third", { activityAt: fixtureSessionActivityAt(3) });
    const screen = await renderSettled({ sessionsByProject: { alpha: [first, second, third] } });
    await waitFor(() => expect(laneTitles(screen.container, "Active")).toHaveLength(3));
    await selectSidebarSession(screen.container, "Second");
    expect(getMountedSessionIds(screen.container)).toEqual([second.id]);

    await pressSettle(screen.container, "Second");

    await waitFor(() => expect(getMountedSessionIds(screen.container)).toEqual([third.id]));
  });

  test("a settled chat leaves its Project and waits on the Settled shelf to be reopened", async () => {
    const open = chat("Still open", { activityAt: fixtureSessionActivityAt(2) });
    const finished = {
      ...chat("Finished", { activityAt: fixtureSessionActivityAt(1) }),
      settledAt: 5,
    };
    const screen = await renderSettled({ sessionsByProject: { alpha: [open, finished] } });

    await waitFor(() => expect(getThreadRow(screen.container, "Still open")).not.toBeNull());
    expect(
      screen.container.querySelector('[data-app-action-sidebar-thread-title="Finished"]'),
    ).toBeNull();

    const settled = getSidebarSection(screen.container, "Settled");
    expect(settled.getAttribute("data-app-action-sidebar-section-collapsed")).toBe("true");
    await act(async () => {
      fireEvent.click(within(settled).getByRole("button", { name: /Settled/ }));
      await Promise.resolve();
    });
    await waitFor(() => expect(laneTitles(screen.container, "Settled")).toEqual(["Finished"]));

    await pressSettle(screen.container, "Finished", "Reopen chat");

    expect(setSettledCalls(finished.id)).toEqual([false]);
    await waitFor(() => expect(laneTitles(screen.container, "Settled")).toEqual([]));
    await waitFor(() =>
      expect(
        getSidebarSection(screen.container, "Projects").querySelector(
          '[data-app-action-sidebar-thread-title="Finished"]',
        ),
      ).not.toBeNull(),
    );
  });
  test("a chat whose Page waits for the reader's review says so, and its check accepts the work", async () => {
    setSidebarOrganizeForTest("attention");
    const review = chat("Fix login race", {
      activityAt: fixtureSessionActivityAt(1),
      pageTurn: {
        page_id: "page-login",
        actor: { kind: "members" },
        reason: "review",
        since: "2026-01-01T00:00:00.000Z",
        episode: "episode-review",
        hold: null,
      },
    });
    setReplyPreviewsForTest({ [review.id]: "Fixed the token refresh race." });
    const screen = await renderSettled({ sessionsByProject: { alpha: [review] } });

    const row = await waitFor(() => getThreadRow(screen.container, "Fix login race"));
    await waitFor(() =>
      expect(row.querySelector("[data-app-action-sidebar-thread-preview]")?.textContent).toBe(
        "Ready for your review · Fixed the token refresh race.",
      ),
    );

    await pressSettle(screen.container, "Fix login race", "Accept and settle");
    const accepts = invokeCalls.filter((call) => call[0] === "work:accept");
    expect(accepts).toHaveLength(1);
    expect(accepts[0]?.[1]).toMatchObject({ pageId: "page-login", turnEpisode: "episode-review" });
    // Accepting is the decision; the chat settles when its work is Done, not by a second call.
    expect(setSettledCalls(review.id)).toEqual([]);
  });

  test("snoozing a chat from its row sets it aside until the time chosen", async () => {
    setSidebarOrganizeForTest("attention");
    const later = chat("Come back to this", { activityAt: fixtureSessionActivityAt(1) });
    const screen = await renderSettled({ sessionsByProject: { alpha: [later] } });
    await waitFor(() =>
      expect(laneTitles(screen.container, "Active")).toEqual(["Come back to this"]),
    );

    await act(async () => {
      const trigger = within(getThreadRow(screen.container, "Come back to this")).getByRole(
        "button",
        { name: "Snooze" },
      );
      fireEvent.pointerDown(trigger, { button: 0 });
      fireEvent.mouseDown(trigger, { button: 0 });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const inOneHour = await waitFor(() => screen.getByRole("menuitem", { name: /^In 1 hour/ }));
    await act(async () => {
      fireEvent.click(inOneHour);
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const snoozes = invokeCalls.filter(
      (call) =>
        call[0] === "project-sessions:set-snooze" &&
        rendererCommandPayload(call)?.sessionId === later.id,
    );
    expect(snoozes).toHaveLength(1);
    expect(typeof rendererCommandPayload(snoozes[0]!)?.snoozedUntil).toBe("string");
    await waitFor(() => expect(laneTitles(screen.container, "Active")).toEqual([]));
    expect(
      getSidebarSection(screen.container, "Snoozed").getAttribute(
        "data-app-action-sidebar-section-collapsed",
      ),
    ).toBe("true");
  });

  test("showing one Project, the Inbox entry is that Project's Inbox", async () => {
    setSidebarOrganizeForTest("attention");
    setInboxCountsForTest({
      library: 5,
      projects: { alpha: 3, beta: 2 },
      waiting: { library: true, projects: { alpha: true, beta: false } },
    });
    const screen = await renderSettled({
      projects: [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")],
      sessionsByProject: {
        alpha: [chat("Alpha chat")],
        beta: [chat("Beta chat", { projectId: "beta" })],
      },
    });
    const inbox = () =>
      screen.container.querySelector('[data-testid="sidebar-inbox-row-wrapper"]')!;
    await waitFor(() =>
      expect(within(inbox() as HTMLElement).getByLabelText("5 in Inbox")).toBeTruthy(),
    );
    expect(inbox().querySelector('[data-sidebar-status="attention"]')).not.toBeNull();

    await openViewOptions(screen.container);
    const chatsFrom = await waitFor(() => screen.getByRole("menuitem", { name: /^Chats from/ }));
    await act(async () => {
      fireEvent.keyDown(chatsFrom, { key: "ArrowRight" });
      await Promise.resolve();
    });
    await settleAsyncRender();
    const beta = await waitFor(() => screen.getByRole("menuitemradio", { name: /Beta/ }));
    await act(async () => {
      fireEvent.click(beta);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Showing Beta. Show all projects" })).toBeTruthy(),
    );
    expect(within(inbox() as HTMLElement).getByLabelText("2 in Inbox")).toBeTruthy();
    expect(inbox().querySelector('[data-sidebar-status="attention"]')).toBeNull();
  });
  test("settling the read chats takes only those, and one Undo brings them all back", async () => {
    setSidebarOrganizeForTest("attention");
    const readA = chat("Read one", { activityAt: fixtureSessionActivityAt(1) });
    const unread = chat("Still unread", { activityAt: fixtureSessionActivityAt(2), unread: true });
    const readB = chat("Read two", { activityAt: fixtureSessionActivityAt(3) });
    const screen = await renderSettled({ sessionsByProject: { alpha: [readA, unread, readB] } });
    await waitFor(() =>
      expect(laneTitles(screen.container, "Active")).toEqual([
        "Read one",
        "Still unread",
        "Read two",
      ]),
    );

    await act(async () => {
      fireEvent.click(
        within(getSidebarSection(screen.container, "Active")).getByRole("button", {
          name: "Settle 2 read chats",
        }),
      );
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const batches = invokeCalls
      .filter((call) => call[0] === "project-sessions:set-settled")
      .map((call) => rendererCommandPayload(call));
    expect(batches).toEqual([{ sessionIds: [readA.id, readB.id], settled: true }]);
    await waitFor(() => expect(laneTitles(screen.container, "Active")).toEqual(["Still unread"]));
    // The chat on screen settled, so the one that took its place opens, read.
    await waitFor(() => expect(markConversationAsReadCalls).toEqual([unread.thread!.threadId]));
    const toast = __getNodexToastSnapshotForTests().find(
      (item) => item.title === "Settled 2 chats",
    );
    expect(toast?.action?.label).toBe("Undo");

    await act(async () => {
      toast?.action?.onClick();
      await Promise.resolve();
    });
    await settleAsyncRender();
    await settleAsyncRender();
    expect(setSettledCalls(readA.id)).toEqual([true, false]);
    expect(setSettledCalls(readB.id)).toEqual([true, false]);
    await waitFor(() =>
      expect(laneTitles(screen.container, "Active")).toEqual([
        "Read one",
        "Still unread",
        "Read two",
      ]),
    );
  });

  test("a chat back from its snooze says so until it is read", async () => {
    setSidebarOrganizeForTest("attention");
    const woke = chat("Back again", { unread: true, wokeAt: 5 });
    const screen = await renderSettled({ sessionsByProject: { alpha: [woke] } });
    const row = await waitFor(() => getThreadRow(screen.container, "Back again"));
    expect(row.querySelector('[data-sidebar-status="woke"]')?.getAttribute("aria-label")).toBe(
      "Back from snooze",
    );
  });
});
