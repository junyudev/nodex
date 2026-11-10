import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect } from "vite-plus/test";
import { waitFor, act, fireEvent, within } from "@testing-library/react";
import { __getNodexToastSnapshotForTests } from "@/components/ui/toast";
import { settleAsyncRender, textContent } from "../../test/dom";
import {
  makeAttachedSession,
  makeAutomationInboxItem,
  makeBlankSession,
  makeProject,
  makeAutomation,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  getLastThreadStageActions,
  installTerminalEventApiMock,
  invokeCalls,
  mockInvokeImpl,
  pendingWorktreeWarningListener,
  renderWorkbench,
  rendererCommandPayload,
  requestThreadStreamSnapshotCalls,
  agentRuntimeLaunchCalls,
  setMockInvokeImpl,
} from "./workbench-testkit/workbench-shell-harness";
import { isUuidV7 } from "../../../shared/uuid-v7";

function expectFirstSubmissionIdentity(input: unknown): void {
  const launch = input as {
    readonly launchId?: string;
    readonly message?: { readonly messageId: string };
  };
  expect(isUuidV7(launch.launchId ?? "")).toBe(true);
  expect(isUuidV7(launch.message?.messageId ?? "")).toBe(true);
}

async function selectAutomationModel(screen: ReturnType<typeof renderWorkbench>, name: string) {
  const trigger = await screen.findByRole("button", { name: "Agent intelligence" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(trigger);
    await Promise.resolve();
  });
  const model = await screen.findByRole("option", { name });
  await act(async () => {
    fireEvent.click(model);
    await Promise.resolve();
  });
}

type WorkbenchScreen = ReturnType<typeof renderWorkbench>;

async function click(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
}

async function openAutomations(screen: WorkbenchScreen) {
  await settleAsyncRender();
  await settleAsyncRender();
  await click(screen.getByRole("button", { name: "Automations" }));
  await screen.findByTestId("automations-route");
  await settleAsyncRender();
}

/** Opens a menu or picker from its trigger and chooses one of its items. */
async function pick(
  screen: WorkbenchScreen,
  trigger: Element,
  item: string | RegExp,
  role: "menuitem" | "option" = "menuitem",
) {
  // Menus open on press; searchable pickers are popovers that open on click.
  await act(async () => {
    if (role === "option") fireEvent.click(trigger);
    else fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
    await Promise.resolve();
  });
  await click(await screen.findByRole(role, { name: item }));
}

function taskRow(screen: WorkbenchScreen, taskId: string): HTMLElement {
  const row = screen.container.querySelector(`[data-automation-id="${taskId}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`Expected the ${taskId} row`);
  return row;
}

async function chooseTaskAction(screen: WorkbenchScreen, taskId: string, action: string) {
  await waitFor(() => taskRow(screen, taskId));
  await pick(
    screen,
    within(taskRow(screen, taskId)).getByRole("button", { name: "More automation actions" }),
    action,
  );
}

describe("workbench session shell / automations-conversation", () => {
  test.each(["run", "ask_first"] as const)(
    "%s Automations expose their Owner and enforce the Owner's editing controls",
    async (mode) => {
      const automation = makeAutomation({
        id: "owned-automation",
        kind: "cron",
        mode,
        ownerMemberId: "member-other",
      });
      const screen = renderWorkbench({ clockAutomations: [automation] });
      const base = mockInvokeImpl;
      if (!base) throw new Error("Expected Core transport");
      setMockInvokeImpl(async (channel, ...args) => {
        const read = args[1] as { read?: { mode?: string } } | undefined;
        if (channel === "library-module:read" && read?.read?.mode === "members") {
          return {
            ok: true,
            value: {
              value: {
                kind: "members",
                items: [
                  {
                    id: "member-owner",
                    library_id: "library:test",
                    display_name: "You",
                    lifecycle: "active",
                    role: "owner",
                    revision: 1,
                  },
                  {
                    id: "member-other",
                    library_id: "library:test",
                    display_name: "Alex",
                    lifecycle: "active",
                    role: "member",
                    revision: 1,
                  },
                ],
              },
            },
          };
        }
        return await base(channel, ...args);
      });
      await openAutomations(screen);
      await chooseTaskAction(screen, automation.id, "Edit");
      const dialog = await screen.findByRole("dialog", { name: "Edit automation" });
      const fields = within(dialog);
      expect(fields.getByRole("button", { name: "Owner" })).toBeTruthy();
      expect((fields.getByRole("button", { name: "Mode" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(
        (fields.getByRole("textbox", { name: "Condition" }) as HTMLInputElement).disabled,
      ).toBe(mode === "run");
      expect(
        (fields.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).disabled,
      ).toBe(mode === "run");
      expect((fields.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    },
  );

  test("Dry run shows its recorded decisions without creating a chat or a run", async () => {
    const automation = makeAutomation({
      id: "observe-automation",
      kind: "cron",
      mode: "dry_run",
      name: "Watch the queue",
    });
    const screen = renderWorkbench({ clockAutomations: [automation] });
    const base = mockInvokeImpl;
    if (!base) throw new Error("Expected Core transport");
    setMockInvokeImpl(async (channel, ...args) =>
      channel === "automations:decisions:list"
        ? {
            items: [
              {
                id: "decision-1",
                dispatchId: "dispatch-1",
                automationId: automation.id,
                status: "completed",
                mode: "dry_run",
                reason: "The weekly condition matched",
                occurredAt: Date.parse("2026-11-06T01:00:00Z"),
                pageId: null,
                sessionId: null,
              },
            ],
          }
        : await base(channel, ...args),
    );
    await openAutomations(screen);
    await click(within(taskRow(screen, automation.id)).getAllByRole("button")[0]!);
    const history = await screen.findByRole("region", { name: "Recent decisions" });
    await within(history).findByText("The weekly condition matched");
    expect(within(history).getByText("Dry run")).toBeTruthy();
    expect(agentRuntimeLaunchCalls).toEqual([]);
    expect(screen.getRunNowAutomationIds()).toEqual([]);
  });

  test("replies about an automation using the available OpenCode Agent", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeBlankSession({ id: "session:alpha:scheduled-reply" })] },
      clockAutomations: [
        makeAutomation({
          id: "task-reply",
          kind: "cron",
          projectId: "alpha",
          name: "Review task",
          targetSessionId: null,
        }),
      ],
    });
    const base = mockInvokeImpl;
    if (!base) throw new Error("Expected Runtime transport");
    setMockInvokeImpl(async (channel, ...args) => {
      const value = await base(channel, ...args);
      return channel === "agent-runtime:providers:read"
        ? (value as Record<string, unknown>[]).map((provider) => ({
            ...provider,
            instanceId: "opencode:configured",
            driver: "opencode",
          }))
        : value;
    });
    await openAutomations(screen);
    await click(
      within(taskRow(screen, "task-reply")).getByRole("button", { name: /Review task/u }),
    );
    const reply = await screen.findByRole("textbox", { name: "Reply about this automation" });
    await act(async () => {
      fireEvent.change(reply, { target: { value: "Include the integration tests." } });
      await Promise.resolve();
    });
    await click(screen.getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(agentRuntimeLaunchCalls).toHaveLength(1));
    expect(agentRuntimeLaunchCalls[0]).toMatchObject({
      projectId: "alpha",
      modelSelection: { instanceId: "opencode:configured" },
      message: { text: expect.stringContaining("Include the integration tests.") },
    });
    await waitFor(() => expect(screen.queryByTestId("automations-route")).toBeNull());
    expect(screen.getByTestId("automations-sidebar")).not.toBeNull();
  });

  test("surfaces pending heartbeat handoff failure from the app-level coordinator", async () => {
    renderWorkbench();

    await waitFor(() => {
      if (pendingWorktreeWarningListener) return;
      throw new Error("Expected the workbench warning subscription.");
    });

    await act(async () => {
      pendingWorktreeWarningListener?.({
        clientThreadId: "client-new-thread:heartbeat-warning",
        kind: "heartbeat-automation-create-failed",
        message: "Started task, but could not create the heartbeat",
        pendingWorktreeId: "local:heartbeat-warning",
        threadId: "thread-heartbeat-warning",
      });
      await Promise.resolve();
    });

    const snapshot = __getNodexToastSnapshotForTests();
    expect(snapshot.length).toBe(1);
    expect(snapshot[0]?.level).toBe("danger");
    expect(String((snapshot[0] as { title?: unknown }).title ?? "")).toBe(
      "Started task, but could not create the heartbeat",
    );
  });

  test("creates a Dry run Automation with its condition, then edits and deletes it from the sidebar", async () => {
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-crud" })],
      },
      clockAutomations: [],
      worktreeEnvironmentOptionsByProject: {
        alpha: [
          {
            path: ".codex/environments/environment.toml",
            name: "CI setup",
            hasSetupScript: true,
            hasCleanupScript: false,
            actionCount: 0,
          },
        ],
      },
    });
    await openAutomations(screen);

    await click(screen.getByRole("button", { name: "New automation" }));
    const dialog = await screen.findByRole("dialog", { name: "New automation" });
    const create = within(dialog).getByRole("button", { name: "Create" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Instructions" }), {
        target: { value: "Triage the weekly project queue." },
      });
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Condition" }), {
        target: { value: "Every week before planning" },
      });
      await Promise.resolve();
    });
    await pick(screen, within(dialog).getByRole("button", { name: "Repeat" }), "Weekly");
    await pick(screen, within(dialog).getByRole("button", { name: "Mode" }), "Dry run");
    await pick(screen, within(dialog).getByRole("button", { name: "Time" }), "10:30 AM", "option");
    await click(within(dialog).getByRole("button", { name: "Advanced" }));
    await pick(screen, within(dialog).getByRole("button", { name: "Project" }), /Alpha/u);
    await pick(screen, within(dialog).getByRole("button", { name: "Workspace" }), "Worktree");
    await pick(
      screen,
      await within(dialog).findByRole("button", { name: "Environment" }),
      /CI setup/u,
    );
    await selectAutomationModel(screen, "GPT-5.5 High");
    await waitFor(() => expect(create.disabled).toBe(false));
    await click(create);

    await waitFor(() => expect(screen.getAutomations().length).toBe(1));
    expect(screen.getAutomations()[0]).toMatchObject({
      mode: "dry_run",
      conditionText: "Every week before planning",
      name: "Triage the weekly project queue",
      prompt: "Triage the weekly project queue.",
      cwds: ["/tmp/project"],
      executionEnvironment: "worktree",
      localEnvironmentConfigPath: ".codex/environments/environment.toml",
      rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=10;BYMINUTE=30",
      model: "gpt-5.5-high",
      reasoningEffort: "high",
    });
    const route = screen.getByTestId("automations-route");
    expect(
      await within(route).findByRole("button", {
        name: "Triage the weekly project queue settings",
      }),
    ).not.toBeNull();
    expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull();

    await chooseTaskAction(screen, "automation-1", "Edit");
    const editDialog = await screen.findByRole("dialog", { name: "Edit automation" });
    const name = within(editDialog).getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    expect(name.value).toBe("Triage the weekly project queue");
    await act(async () => {
      fireEvent.change(name, { target: { value: "Updated triage" } });
      await Promise.resolve();
    });
    await click(within(editDialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getAutomations()[0]?.name).toBe("Updated triage"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit automation" })).toBeNull(),
    );

    await chooseTaskAction(screen, "automation-1", "Delete");
    const confirm = await screen.findByRole("dialog", { name: "Delete automation?" });
    await click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.getAutomations().length).toBe(0));
    expect(await screen.findByRole("heading", { level: 1, name: "New automation" })).not.toBeNull();
  });

  test("starts a task from a template and asks before discarding changes", async () => {
    const screen = renderWorkbench({ clockAutomations: [] });
    await openAutomations(screen);
    const suggestions = screen.getByRole("list", { name: "Suggested automations" });

    await click(within(suggestions).getByRole("button", { name: /Daily bug scan/u }));
    let dialog = await screen.findByRole("dialog", { name: "New automation" });
    const instructions = within(dialog).getByRole("textbox", {
      name: "Instructions",
    }) as HTMLTextAreaElement;
    expect(instructions.value.startsWith("Scan recent commits")).toBe(true);
    // An untouched template closes without asking.
    await act(async () => {
      fireEvent.keyDown(instructions, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull(),
    );

    await click(within(suggestions).getByRole("button", { name: /Daily bug scan/u }));
    dialog = await screen.findByRole("dialog", { name: "New automation" });
    await act(async () => {
      fireEvent.change(within(dialog).getByRole("textbox", { name: "Instructions" }), {
        target: { value: "Only scan the API package." },
      });
      await Promise.resolve();
    });
    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    const discard = await screen.findByRole("dialog", { name: "Discard changes?" });
    await click(within(discard).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("dialog", { name: "New automation" })).not.toBeNull();

    await click(within(dialog).getByRole("button", { name: "Cancel" }));
    await click(
      within(await screen.findByRole("dialog", { name: "Discard changes?" })).getByRole("button", {
        name: "Discard changes",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New automation" })).toBeNull(),
    );
    expect(screen.getAutomations().length).toBe(0);
  });

  test("task actions pause, resume, run now, and roll back a failed status change", async () => {
    installTerminalEventApiMock();
    const active = makeAutomation({
      id: "automation-active",
      name: "Runnable task",
      targetSessionId: "session:alpha:automation-row-actions",
    });
    const paused = makeAutomation({
      id: "automation-paused",
      name: "Paused task",
      status: "PAUSED",
      targetSessionId: "session:alpha:automation-row-paused",
      nextRunAt: null,
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-row-actions" })],
      },
      clockAutomations: [active, paused],
    });
    await openAutomations(screen);

    expect(textContent(taskRow(screen, "automation-paused"))).toContain("Paused · Daily");
    await chooseTaskAction(screen, "automation-active", "Run now");
    await waitFor(() => expect(screen.getRunNowAutomationIds()).toEqual(["automation-active"]));
    expect(
      __getNodexToastSnapshotForTests().some(
        (record) => record.level === "info" && record.title === "Automation started",
      ),
    ).toBe(true);

    await chooseTaskAction(screen, "automation-paused", "Resume");
    await waitFor(() =>
      expect(screen.getAutomations().find((task) => task.id === "automation-paused")?.status).toBe(
        "ACTIVE",
      ),
    );

    let rejectUpdate: ((error: Error) => void) | null = null;
    const baseMockInvokeImpl = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "automations:update") {
        return await new Promise<never>((_resolve, reject) => {
          rejectUpdate = reject;
        });
      }
      return baseMockInvokeImpl?.(channel, ...args) ?? null;
    });
    await chooseTaskAction(screen, "automation-active", "Pause");
    await waitFor(() =>
      expect(textContent(taskRow(screen, "automation-active"))).toContain("Paused"),
    );
    await act(async () => {
      rejectUpdate?.(new Error("Host update failed"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(textContent(taskRow(screen, "automation-active"))).not.toContain("Paused"),
    );
    expect(
      __getNodexToastSnapshotForTests().some(
        (record) =>
          record.level === "danger" &&
          record.title === "Could not update automation" &&
          record.description === "Host update failed",
      ),
    ).toBe(true);
  });

  test("reports run-now and delete failures with automation toast titles", async () => {
    installTerminalEventApiMock();
    const active = makeAutomation({ id: "automation-failing", name: "Failing task" });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-failures" })],
      },
      clockAutomations: [active],
    });
    await openAutomations(screen);
    const baseMockInvokeImpl = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "automations:run-now") {
        throw new Error("Automation is missing");
      }
      if (channel === "automations:delete") {
        return { item: active, success: false, status: "remove_failed" };
      }
      return baseMockInvokeImpl?.(channel, ...args) ?? null;
    });

    await chooseTaskAction(screen, "automation-failing", "Run now");
    await chooseTaskAction(screen, "automation-failing", "Delete");
    const confirm = await screen.findByRole("dialog", { name: "Delete automation?" });
    await click(within(confirm).getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      const titles = __getNodexToastSnapshotForTests()
        .filter((record) => record.level === "danger")
        .map((record) => (record as { title?: unknown }).title);
      expect(titles).toContain("Could not start automation");
      expect(titles).toContain("Could not delete automation");
    });
    expect(screen.getAutomations().length).toBe(1);
  });

  test("cron tasks open as folders of runs, and runs and Heartbeats open their chat in place", async () => {
    installTerminalEventApiMock();
    const cron = makeAutomation({
      id: "automation-history",
      kind: "cron",
      projectId: "alpha",
      name: "History task",
      prompt: "Summarize the previous run history.",
      targetSessionId: null,
      model: "gpt-5",
      reasoningEffort: "low",
      cwds: ["/tmp/project-alpha"],
    });
    const heartbeat = makeAutomation({
      id: "automation-heartbeat",
      name: "Standup check-in",
      targetSessionId: "session:alpha:heartbeat",
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [
          // The chat shown at launch, so neither Automation's chat has been seen yet.
          makeAttachedSession({
            id: "session:alpha:unrelated",
            title: "Unrelated chat",
            threadId: "thread-unrelated",
          }),
          makeAttachedSession({
            id: "session:alpha:heartbeat",
            title: "Standup chat",
            threadId: "thread-heartbeat",
          }),
          makeAttachedSession({
            id: "session:thread-run-latest",
            title: "Latest run chat",
            threadId: "thread-run-latest",
          }),
        ],
      },
      clockAutomations: [cron, heartbeat],
      automationInboxItems: [
        makeAutomationInboxItem({
          id: "thread-run-latest",
          runId: "thread-run-latest",
          sessionId: "session:thread-run-latest",
          automationId: "automation-history",
          automationName: "History task",
          title: "Latest history run",
          createdAt: 300,
          readAt: null,
          status: "PENDING_REVIEW",
        }),
        makeAutomationInboxItem({
          id: "thread-run-archived",
          runId: "thread-run-archived",
          sessionId: "session:thread-run-archived",
          automationId: "automation-history",
          automationName: "History task",
          title: "Archived history run",
          createdAt: 200,
          readAt: 50,
          status: "ARCHIVED",
        }),
        ...["beat-1", "beat-2"].map((runId, index) =>
          makeAutomationInboxItem({
            id: runId,
            runId,
            sessionId: "session:alpha:heartbeat",
            automationId: "automation-heartbeat",
            automationName: "Standup check-in",
            createdAt: 100 + index,
            readAt: null,
            status: "PENDING_REVIEW",
          }),
        ),
      ],
    });
    await openAutomations(screen);

    const row = taskRow(screen, "automation-history");
    expect(within(row).getByLabelText("Unread")).not.toBeNull();
    await click(within(row).getByRole("button", { name: /History task/u }));
    const runs = await screen.findByRole("list", { name: "History task runs" });
    expect(
      within(runs)
        .getAllByRole("listitem")
        .map((item) => textContent(item)),
    ).toEqual(["Latest history run"]);
    expect(
      await within(screen.getByTestId("automations-route")).findByText(
        "Summarize the previous run history.",
      ),
    ).not.toBeNull();

    await click(within(runs).getByRole("button", { name: /Latest history run/u }));
    await waitFor(() =>
      expect(textContent(screen.container)).toContain("Thread:thread-run-latest"),
    );
    expect(screen.queryByTestId("automations-route")).toBeNull();
    expect(screen.getByTestId("automations-sidebar")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Automations" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await waitFor(() =>
      expect(
        screen.getAutomationInboxItems().find((item) => item.runId === "thread-run-latest")?.readAt,
      ).not.toBeNull(),
    );

    expect(within(taskRow(screen, "automation-heartbeat")).getByLabelText("Unread")).not.toBeNull();
    await click(
      within(taskRow(screen, "automation-heartbeat")).getByRole("button", {
        name: /Standup check-in/u,
      }),
    );
    await waitFor(() => expect(textContent(screen.container)).toContain("Thread:thread-heartbeat"));
    // Every beat lands in the one chat, so showing it reads them all.
    await waitFor(() =>
      expect(within(taskRow(screen, "automation-heartbeat")).queryByLabelText("Unread")).toBeNull(),
    );
    expect(
      screen
        .getAutomationInboxItems()
        .filter((item) => item.automationId === "automation-heartbeat")
        .every((item) => item.readAt !== null),
    ).toBe(true);
    expect(
      within(taskRow(screen, "automation-heartbeat"))
        .getByRole("button", { name: /Standup check-in/u })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByTestId("automations-sidebar")).not.toBeNull();
  });

  test("searches tasks by name from the sidebar", async () => {
    const screen = renderWorkbench({
      clockAutomations: [
        makeAutomation({ id: "automation-digest", name: "Morning digest" }),
        makeAutomation({ id: "automation-review", name: "Code review sweep" }),
      ],
    });
    await openAutomations(screen);

    const toggle = screen.getByRole("button", { name: "Search automations" });
    await click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const search = screen.getByRole("textbox", { name: "Search automations" });
    await act(async () => {
      fireEvent.change(search, { target: { value: "DIGEST" } });
      await Promise.resolve();
    });
    const list = screen.getByRole("list", { name: "Upcoming" });
    expect(within(list).getAllByRole("listitem").length).toBe(1);
    expect(textContent(list)).toContain("Morning digest");

    await act(async () => {
      fireEvent.change(search, { target: { value: "nothing like this" } });
      await Promise.resolve();
    });
    expect(within(screen.getByTestId("automations-sidebar")).getByRole("status").textContent).toBe(
      "No matching automations",
    );
    await act(async () => {
      fireEvent.keyDown(search, { key: "Escape" });
      await Promise.resolve();
    });
    expect(screen.queryByRole("textbox", { name: "Search automations" })).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  test("session composer submit starts a session-owned thread and refreshes sessions", async () => {
    const screen = renderWorkbench({
      sessionsByProject: { alpha: [makeBlankSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(agentRuntimeLaunchCalls.length).toBe(1);
    expectFirstSubmissionIdentity(agentRuntimeLaunchCalls[0]);
    expect(agentRuntimeLaunchCalls[0]).toMatchObject({
      projectId: "alpha",
      sessionId: "session:alpha:blank",
      message: { text: "Start from session" },
      runInTarget: "localProject",
      runInEnvironmentPath: null,
      interactionMode: "default",
    });
    expect(
      invokeCalls.some((call) => call[0] === "workspace:tasks:list" && call[1] === "alpha"),
    ).toBe(true);
  });

  test("inline message edit submits one prepared Session rewrite", async () => {
    renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            thread: null,
            executionRef: { runtimeId: "runtime:test", threadId: "thread-alpha" },
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const onEditUserTurn = actions.onEditUserTurn as
      | ((input: {
          threadId: string;
          turnId: string;
          message: string;
          images: [];
        }) => Promise<void>)
      | undefined;
    expect(typeof onEditUserTurn).toBe("function");

    await act(async () => {
      await onEditUserTurn?.({
        threadId: "thread-alpha",
        turnId: "turn-latest",
        message: "Rewrite the latest prompt",
        images: [],
      });
    });
    await settleAsyncRender();

    const message = invokeCalls.findIndex(
      (call) => call[0] === "agent-runtime:session:rewrite-message",
    );
    expect(message).toBeGreaterThanOrEqual(0);
    expect(invokeCalls[message]?.[1]).toMatchObject({
      sessionId: "session:alpha:database-view",
      threadId: "thread-alpha",
      runId: "turn-latest",
    });
    expect(invokeCalls[message]?.[1]).toMatchObject({
      sessionId: "session:alpha:database-view",
      threadId: "thread-alpha",
      message: { text: "Rewrite the latest prompt" },
    });
    expect(JSON.stringify(requestThreadStreamSnapshotCalls)).toBe(JSON.stringify([]));
  });

  test("session queue actions control canonical Runs without a native Thread writer", async () => {
    renderWorkbench({
      sessionsByProject: {
        alpha: [
          makeAttachedSession({
            thread: null,
            executionRef: { runtimeId: "runtime:test", threadId: "thread-alpha" },
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();
    const actions = getLastThreadStageActions() as unknown as {
      onRemoveQueuedFollowUp: (threadId: string, runId: string) => Promise<void>;
      onReorderQueuedFollowUps: (threadId: string, ids: string[]) => Promise<void>;
      onSendQueuedFollowUpNow: (threadId: string, runId: string) => Promise<void>;
    };
    await act(async () => {
      await actions.onRemoveQueuedFollowUp("thread-alpha", "queued:one");
      await actions.onReorderQueuedFollowUps("thread-alpha", ["queued:two", "queued:one"]);
      await actions.onSendQueuedFollowUpNow("thread-alpha", "queued:two");
    });
    const commands = invokeCalls
      .filter((call) => call[0] === "agent-runtime:session:queue")
      .map((call) => call[1]);
    expect(commands).toEqual([
      expect.objectContaining({
        sessionId: "session:alpha:database-view",
        threadId: "thread-alpha",
        action: "cancel",
        runId: "queued:one",
      }),
      expect.objectContaining({
        sessionId: "session:alpha:database-view",
        threadId: "thread-alpha",
        action: "reorder",
        orderedRunIds: ["queued:two", "queued:one"],
      }),
      expect.objectContaining({
        sessionId: "session:alpha:database-view",
        threadId: "thread-alpha",
        action: "resume",
      }),
    ]);
  });

  test("session composer submit creates an owning session when the new-chat project changes", async () => {
    const betaProject = makeProject("beta", "Beta");
    const screen = renderWorkbench({
      projects: [makeProject(), betaProject],
      sessionsByProject: {
        alpha: [makeBlankSession()],
        beta: [
          makeAttachedSession({
            id: "session:beta:database-view",
            projectId: "beta",
            title: "Database View",
          }),
        ],
      },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const propsBefore = (
      globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> }
    ).__lastConnectedThreadStageProps;
    const actions = propsBefore?.actions as
      | {
          onNewThreadProjectChange?: (projectId: string) => void;
        }
      | undefined;
    await act(async () => {
      actions?.onNewThreadProjectChange?.("beta");
      await Promise.resolve();
    });
    await settleAsyncRender();

    const propsAfter = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(JSON.stringify(propsAfter?.newThreadTarget).includes('"projectId":"beta"')).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "project-sessions:ensure-default-draft" &&
          rendererCommandPayload(call)?.projectId === "beta",
      ),
    ).toBe(true);
    expect(agentRuntimeLaunchCalls.length).toBe(1);
    const betaSessionId = rendererCommandPayload(
      invokeCalls.find(
        (call) =>
          call[0] === "project-sessions:ensure-default-draft" &&
          rendererCommandPayload(call)?.projectId === "beta",
      ),
    )?.candidateSessionId;
    expectFirstSubmissionIdentity(agentRuntimeLaunchCalls[0]);
    expect(agentRuntimeLaunchCalls[0]).toMatchObject({
      projectId: "beta",
      sessionId: betaSessionId,
      message: { text: "Start from session" },
      runInTarget: "localProject",
      runInEnvironmentPath: null,
      interactionMode: "default",
    });
    expect(
      invokeCalls.some((call) => call[0] === "workspace:tasks:list" && call[1] === "beta"),
    ).toBe(true);
  });

  test("session composer submit passes the selected new-worktree target", async () => {
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: { alpha: [makeBlankSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const propsBefore = (
      globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> }
    ).__lastConnectedThreadStageProps;
    const actions = propsBefore?.actions as
      | {
          onNewThreadStartInTargetChange?: (target: { runInTarget: "newWorktree" }) => void;
        }
      | undefined;
    await act(async () => {
      actions?.onNewThreadStartInTargetChange?.({ runInTarget: "newWorktree" });
      await Promise.resolve();
    });
    await settleAsyncRender();

    const propsAfter = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
      .__lastConnectedThreadStageProps;
    expect(
      JSON.stringify(propsAfter?.newThreadTarget).includes('"runInTarget":"newWorktree"'),
    ).toBe(true);
    const sessionRefreshCountBeforeSubmit = invokeCalls.filter(
      (call) => call[0] === "project-sessions:list" && call[1] === "alpha",
    ).length;

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(agentRuntimeLaunchCalls.length).toBe(1);
    expectFirstSubmissionIdentity(agentRuntimeLaunchCalls[0]);
    expect(agentRuntimeLaunchCalls[0]).toMatchObject({
      projectId: "alpha",
      sessionId: "session:alpha:blank",
      message: { text: "Start from session" },
      runInTarget: "newWorktree",
      runInEnvironmentPath: null,
      interactionMode: "default",
    });
    expect(screen.queryByTestId("pending-worktree-route-shell")).toBeNull();
    expect(
      invokeCalls.filter((call) => call[0] === "project-sessions:list" && call[1] === "alpha")
        .length,
    ).toBe(sessionRefreshCountBeforeSubmit);
  });
});
