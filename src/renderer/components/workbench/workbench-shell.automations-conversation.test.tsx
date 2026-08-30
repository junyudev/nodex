import "./workbench-testkit/workbench-shell-harness";
import { describe, test, expect, vi } from "vite-plus/test";
import { waitFor, act, fireEvent, within } from "@testing-library/react";
import { __getNodexToastSnapshotForTests } from "@/components/ui/toast";
import { settleAsyncRender, textContent } from "../../test/dom";
import {
  WORKBENCH_AUTOMATION_CREATE_WITH_CHAT_PROMPT,
  WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS,
} from "./workbench-automation-templates";
import {
  makeAttachedSession,
  makeAutomationInboxItem,
  makeBlankSession,
  makeProject,
  makeScheduledAutomation,
} from "./workbench-testkit/workbench-shell-fixtures";
import {
  cleanBackgroundTerminalsCalls,
  editLastUserTurnCalls,
  getHeaderShellSlot,
  getLastThreadStageActions,
  installTerminalEventApiMock,
  invokeCalls,
  mockInvokeImpl,
  pendingWorktreeWarningListener,
  removePlanImplementationRequestCalls,
  removeQueuedFollowUpCalls,
  renderWorkbench,
  rendererCommandPayload,
  reorderQueuedFollowUpsCalls,
  requestThreadStreamSnapshotCalls,
  sendQueuedFollowUpNowCalls,
  setComposerIntentCalls,
  setWindowInnerWidthForTest,
  startThreadForSessionCalls,
  setMockInvokeImpl,
  setStartThreadForSessionResult,
} from "./workbench-testkit/workbench-shell-harness";

describe("workbench session shell / automations-conversation", () => {
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

  test("automations route creates updates and deletes scheduled tasks", async () => {
    const originalInnerWidth = window.innerWidth;
    setWindowInnerWidthForTest(1600);
    try {
      const screen = renderWorkbench({
        projects: [makeProject("alpha", "Alpha", "/tmp/project")],
        sessionsByProject: {
          alpha: [makeAttachedSession({ id: "session:alpha:automation-crud" })],
        },
        scheduledAutomations: [],
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
      await settleAsyncRender();
      await settleAsyncRender();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.container.querySelector('[data-testid="automations-route-shell"]') !== null,
        ).toBe(true);
      });

      expect(screen.getByRole("button", { name: "Create via chat" }) !== null).toBe(true);
      await act(async () => {
        fireEvent.mouseDown(screen.getByLabelText("New scheduled task options"), {
          button: 0,
          ctrlKey: false,
        });
        await Promise.resolve();
      });
      const createViaChatItem = await screen.findByRole("menuitem", { name: "Create via chat" });
      expect(createViaChatItem.getAttribute("aria-disabled")).toBe(null);
      await act(async () => {
        fireEvent.click(screen.getByRole("menuitem", { name: "Create manually" }));
        await Promise.resolve();
      });
      await settleAsyncRender();

      await act(async () => {
        const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
        const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
        nameInput.value = "Weekly triage";
        fireEvent.input(nameInput);
        promptInput.value = "Triage the weekly project queue.";
        fireEvent.input(promptInput);
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.mouseDown(screen.getByLabelText("Project"), { button: 0, ctrlKey: false });
        await Promise.resolve();
      });
      const projectItem = await screen.findByRole("menuitem", { name: /Alpha/u });
      await act(async () => {
        fireEvent.click(projectItem);
        await Promise.resolve();
      });
      await settleAsyncRender();
      const environmentTrigger = await screen.findByLabelText("Environment");
      await act(async () => {
        fireEvent.mouseDown(environmentTrigger, { button: 0, ctrlKey: false });
        await Promise.resolve();
      });
      const environmentItem = await screen.findByRole("menuitem", { name: /CI setup/u });
      await act(async () => {
        fireEvent.click(environmentItem);
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(
          screen.getByLabelText("Environment").textContent?.includes("CI setup") ?? false,
        ).toBe(true);
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Schedule"));
        await Promise.resolve();
      });
      const scheduleTypeTrigger = await screen.findByLabelText("Schedule type");
      await act(async () => {
        fireEvent.mouseDown(scheduleTypeTrigger, { button: 0, ctrlKey: false });
        await Promise.resolve();
      });
      const weeklyItem = await screen.findByRole("menuitem", { name: "Weekly" });
      await act(async () => {
        fireEvent.click(weeklyItem);
        await Promise.resolve();
      });
      await settleAsyncRender();
      await act(async () => {
        const timeInput = screen.getByLabelText("Time") as HTMLInputElement;
        timeInput.value = "10:30";
        fireEvent.input(timeInput);
        await Promise.resolve();
      });
      await settleAsyncRender();
      const modelTrigger = await screen.findByLabelText("Model and reasoning");
      await waitFor(() => {
        expect((modelTrigger as HTMLButtonElement).disabled).toBe(false);
      });
      await act(async () => {
        fireEvent.mouseDown(modelTrigger, { button: 0, ctrlKey: false });
        await Promise.resolve();
      });
      const highModelItem = await screen.findByRole("menuitem", { name: "GPT-5.5 High" });
      await act(async () => {
        fireEvent.click(highModelItem);
        await Promise.resolve();
      });
      await settleAsyncRender();

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create scheduled task" }));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.getScheduledAutomations().length).toBe(1);
      });
      expect(screen.getScheduledAutomations()[0]?.name).toBe("Weekly triage");
      expect(screen.getScheduledAutomations()[0]?.prompt).toBe("Triage the weekly project queue.");
      expect(JSON.stringify(screen.getScheduledAutomations()[0]?.cwds)).toBe(
        JSON.stringify(["/tmp/project"]),
      );
      expect(screen.getScheduledAutomations()[0]?.localEnvironmentConfigPath).toBe(
        ".codex/environments/environment.toml",
      );
      expect(screen.getScheduledAutomations()[0]?.rrule).toBe(
        "FREQ=WEEKLY;BYDAY=SU;BYHOUR=10;BYMINUTE=30",
      );
      expect(screen.getScheduledAutomations()[0]?.model).toBe("gpt-5.5-high");
      expect(screen.getScheduledAutomations()[0]?.reasoningEffort).toBe("high");

      await act(async () => {
        const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
        nameInput.value = "Updated triage";
        fireEvent.input(nameInput);
        await Promise.resolve();
      });
      await settleAsyncRender();

      await waitFor(() => {
        expect(screen.getScheduledAutomations()[0]?.name).toBe("Updated triage");
      });

      const detailRail = screen.getByTestId("automation-detail-rail");
      const headerContextSurface = screen.getByTestId("app-shell-header-context-menu-surface");
      const resizeSeparator = within(detailRail).getByRole("separator", {
        name: "Resize scheduled task details",
      });
      let capturedPointerId: number | null = null;
      resizeSeparator.setPointerCapture = (pointerId: number) => {
        capturedPointerId = pointerId;
      };
      await waitFor(() => {
        expect(detailRail.getAttribute("style")?.includes("width: 820px")).toBe(true);
        expect(headerContextSurface.getAttribute("style")?.includes("margin-right: 820px")).toBe(
          true,
        );
      });
      await act(async () => {
        fireEvent.pointerDown(resizeSeparator, { button: 0, pointerId: 11, clientX: 380 });
        fireEvent.pointerMove(window, { pointerId: 11, clientX: 650 });
        fireEvent.pointerUp(window, { pointerId: 11 });
        await Promise.resolve();
      });
      expect(capturedPointerId).toBe(11);
      await waitFor(() => {
        expect(detailRail.getAttribute("style")?.includes("width: 550px")).toBe(true);
        expect(headerContextSurface.getAttribute("style")?.includes("margin-right: 550px")).toBe(
          true,
        );
      });

      await act(async () => {
        fireEvent.click(within(detailRail).getByRole("button", { name: "Delete scheduled task" }));
        await Promise.resolve();
      });
      const deleteDialog = await screen.findByRole("dialog");
      expect(textContent(deleteDialog).includes("Delete Updated triage?")).toBe(true);
      expect(
        textContent(deleteDialog).includes(
          "This will permanently delete the scheduled task and stop future runs.",
        ),
      ).toBe(true);

      await act(async () => {
        fireEvent.click(
          within(deleteDialog).getByRole("button", { name: "Delete scheduled task" }),
        );
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(screen.getScheduledAutomations().length).toBe(0);
      });
      expect(textContent(screen.container).includes("Create your first scheduled task")).toBe(true);
    } finally {
      setWindowInnerWidthForTest(originalInnerWidth);
    }
  });

  test("automations edit autosave waits for a valid changed draft", async () => {
    installTerminalEventApiMock();
    const automation = makeScheduledAutomation({
      id: "automation-autosave",
      kind: "cron",
      targetThreadId: null,
      name: "Autosave report",
      prompt: "Summarize the project.",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      cwds: ["/tmp/project"],
      executionEnvironment: "local",
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-autosave" })],
      },
      scheduledAutomations: [automation],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const sidebar = screen.getByTestId("project-session-sidebar");
    await act(async () => {
      fireEvent.click(within(sidebar).getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    const routeShell = await screen.findByTestId("automations-route-shell");
    const row = await within(routeShell).findByTestId("automation-list-row-automation-autosave");
    await act(async () => {
      fireEvent.click(row);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
      nameInput.value = "";
      fireEvent.input(nameInput);
      await Promise.resolve();
    });
    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });

      const updateCallCountAfterInvalid = invokeCalls.filter(
        (call) => call[0] === "codex:scheduled-automations:update",
      ).length;
      expect(updateCallCountAfterInvalid).toBe(0);
      expect(screen.getScheduledAutomations()[0]?.name).toBe("Autosave report");

      await act(async () => {
        const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
        nameInput.value = "Autosaved report";
        fireEvent.input(nameInput);
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(600);
      });
      await act(async () => {
        await Promise.resolve();
      });

      const updateCallCount = invokeCalls.filter(
        (call) => call[0] === "codex:scheduled-automations:update",
      ).length;
      expect(updateCallCount).toBe(1);
      expect(screen.getScheduledAutomations()[0]?.name).toBe("Autosaved report");
    } finally {
      vi.useRealTimers();
    }
  });

  test("automations route saves a valid edited model before switching route state", async () => {
    installTerminalEventApiMock();
    const automation = makeScheduledAutomation({
      id: "automation-model-flush",
      kind: "cron",
      targetThreadId: null,
      name: "Model flush report",
      prompt: "Summarize the project model choice.",
      rrule: "DTSTART;TZID=Asia/Shanghai:20260710T090000\nRRULE:FREQ=DAILY",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      cwds: ["/tmp/project"],
      executionEnvironment: "local",
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-model-flush" })],
      },
      scheduledAutomations: [automation],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    const routeShell = await screen.findByTestId("automations-route-shell");
    await act(async () => {
      fireEvent.click(within(routeShell).getByTestId("automation-list-row-automation-model-flush"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const modelTrigger = await screen.findByLabelText("Model and reasoning");
    await waitFor(() => {
      expect((modelTrigger as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.mouseDown(modelTrigger, { button: 0, ctrlKey: false });
      await Promise.resolve();
    });
    const highModelItem = await screen.findByRole("menuitem", { name: "GPT-5.5 High" });
    await act(async () => {
      fireEvent.click(highModelItem);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Templates" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      const saved = screen
        .getScheduledAutomations()
        .find((item) => item.id === "automation-model-flush");
      expect(saved?.model).toBe("gpt-5.5-high");
      expect(saved?.reasoningEffort).toBe("high");
      expect(screen.getByRole("button", { name: "Templates" }).getAttribute("aria-pressed")).toBe(
        "true",
      );
    });
    const updateCall = invokeCalls.find((call) => call[0] === "codex:scheduled-automations:update");
    expect((updateCall?.[1] as { rrule?: string } | undefined)?.rrule).toBe(
      "DTSTART;TZID=Asia/Shanghai:20260710T090000\nRRULE:FREQ=DAILY",
    );
  });

  test("automations previous run click saves pending edits and opens the run chat", async () => {
    installTerminalEventApiMock();
    const automation = makeScheduledAutomation({
      id: "automation-history-open",
      kind: "cron",
      targetThreadId: null,
      name: "History open task",
      prompt: "Summarize the run before opening.",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      cwds: ["/tmp/project"],
      executionEnvironment: "local",
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/tmp/project")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-history-open" })],
      },
      scheduledAutomations: [automation],
      automationInboxItems: [
        makeAutomationInboxItem({
          id: "thread-run-open",
          threadId: "thread-run-open",
          automationId: "automation-history-open",
          automationName: "History open task",
          title: "Openable history run",
          description: "Ready for review.",
          sourceCwd: "/tmp/project",
          createdAt: 300,
          readAt: null,
          status: "PENDING_REVIEW",
        }),
      ],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    const routeShell = await screen.findByTestId("automations-route-shell");
    await act(async () => {
      fireEvent.click(
        within(routeShell).getByTestId("automation-list-row-automation-history-open"),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(textContent(screen.container).includes("Openable history run")).toBe(true);
    });

    const modelTrigger = await screen.findByLabelText("Model and reasoning");
    await waitFor(() => {
      expect((modelTrigger as HTMLButtonElement).disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.mouseDown(modelTrigger, { button: 0, ctrlKey: false });
      await Promise.resolve();
    });
    const highModelItem = await screen.findByRole("menuitem", { name: "GPT-5.5 High" });
    await act(async () => {
      fireEvent.click(highModelItem);
      await Promise.resolve();
    });

    const runButton = within(
      screen.getByTestId("automation-previous-run-thread-run-open"),
    ).getByRole("button", { name: "Openable history run" });
    await act(async () => {
      fireEvent.click(runButton);
      await Promise.resolve();
    });

    await waitFor(() => {
      const saved = screen
        .getScheduledAutomations()
        .find((item) => item.id === "automation-history-open");
      expect(saved?.model).toBe("gpt-5.5-high");
      expect(saved?.reasoningEffort).toBe("high");
      expect(screen.container.querySelector('[data-testid="automations-route-shell"]')).toBe(null);
      expect(textContent(screen.container).includes("Thread:thread-run-open")).toBe(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    const returnedRouteShell = await screen.findByTestId("automations-route-shell");
    const returnedHeaderSurface = screen.getByTestId("app-shell-header-context-menu-surface");
    const returnedRightSlot = getHeaderShellSlot(screen, "right");
    await waitFor(() => {
      expect(returnedRightSlot.getAttribute("style")?.includes("width: 0px")).toBe(true);
      expect(returnedRightSlot.getAttribute("style")?.includes("min-width: 0")).toBe(true);
      expect(
        within(returnedHeaderSurface).queryByRole("button", { name: "Create via chat" }) !== null,
      ).toBe(true);
      expect(within(returnedHeaderSurface).queryByRole("button", { name: "Tasks" }) !== null).toBe(
        true,
      );
    });
    expect(returnedRouteShell.contains(returnedHeaderSurface)).toBe(false);
    expect(
      within(screen.getByTestId("workbench-global-header")).queryByRole("button", {
        name: "Toggle side panel",
      }),
    ).toBe(null);
  });

  test("automations route create via chat pre-fills a blank session composer", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-chat-create" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(screen.getByLabelText("New scheduled task options"), {
        button: 0,
        ctrlKey: false,
      });
      await Promise.resolve();
    });
    const createViaChatItem = await screen.findByRole("menuitem", { name: "Create via chat" });
    await act(async () => {
      fireEvent.click(createViaChatItem);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.container.querySelector('[data-testid="automations-route-shell"]')).toBe(null);
    });
    const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(promptInput.value).toBe(WORKBENCH_AUTOMATION_CREATE_WITH_CHAT_PROMPT);
    });
    expect(
      invokeCalls.some(
        (call) =>
          call[0] === "project-sessions:ensure-default-draft" &&
          rendererCommandPayload(call)?.projectId === "alpha",
      ),
    ).toBe(true);
    expect(startThreadForSessionCalls.length).toBe(0);
  });

  test("automations route confirms before discarding a changed create draft", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-discard" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.mouseDown(screen.getByLabelText("New scheduled task options"), {
        button: 0,
        ctrlKey: false,
      });
      await Promise.resolve();
    });
    const createManuallyItem = await screen.findByRole("menuitem", { name: "Create manually" });
    await act(async () => {
      fireEvent.click(createManuallyItem);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
      nameInput.value = "Draft only";
      fireEvent.input(nameInput);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse details" }));
      await Promise.resolve();
    });
    const discardDialog = await screen.findByRole("dialog");
    expect(textContent(discardDialog).includes("Discard scheduled task draft?")).toBe(true);
    expect(
      textContent(discardDialog).includes("Your changes to this scheduled task will be lost"),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(within(discardDialog).getByRole("button", { name: "Keep editing" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBe(null);
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Draft only");
    expect(screen.container.querySelector('[data-testid="automation-detail-rail"]') !== null).toBe(
      true,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Collapse details" }));
      await Promise.resolve();
    });
    const secondDiscardDialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(secondDiscardDialog).getByRole("button", { name: "Discard" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.container.querySelector('[data-testid="automation-detail-rail"]')).toBe(null);
    });
    expect(textContent(screen.container).includes("Create your first scheduled task")).toBe(true);
  });

  test("automations route opens system templates as create drafts", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-template" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Templates" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(textContent(screen.container).includes("Daily bug scan")).toBe(true);
      expect(textContent(screen.container).includes("System")).toBe(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("automation-template-daily-bug-scan"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(screen.container.querySelector('[data-testid="automation-detail-rail"]') !== null).toBe(
      true,
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Daily bug scan");
    expect(
      (screen.getByLabelText("Prompt") as HTMLTextAreaElement).value.includes(
        "Scan recent commits",
      ),
    ).toBe(true);
    expect(textContent(screen.getByLabelText("Schedule")).includes("Daily at 9:00 AM")).toBe(true);
    expect(screen.getByRole("button", { name: "Personalize with Nodex" }) !== null).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Personalize with Nodex" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(startThreadForSessionCalls.length).toBe(1);
    });
    const startInput = startThreadForSessionCalls[0] as
      | {
          projectId?: string;
          sessionId?: string;
          prompt?: string;
          runInTarget?: string;
          collaborationMode?: string;
        }
      | undefined;
    const createSessionPayload = rendererCommandPayload(
      invokeCalls.find(
        (call) =>
          call[0] === "project-sessions:create" ||
          call[0] === "project-sessions:ensure-default-draft",
      ),
    );
    const createSessionId =
      createSessionPayload?.sessionId ?? createSessionPayload?.candidateSessionId;
    expect(startInput?.projectId).toBe("alpha");
    expect(startInput?.sessionId).toBe(createSessionId);
    expect(startInput?.runInTarget).toBe("localProject");
    expect(startInput?.collaborationMode).toBe("default");
    expect(startInput?.prompt?.includes('mode: "suggested_create"')).toBe(true);
    expect(startInput?.prompt?.includes('Template: "Daily bug scan"')).toBe(true);
    expect(JSON.stringify(requestThreadStreamSnapshotCalls)).toBe(
      JSON.stringify(["thread-started"]),
    );
    expect(screen.container.querySelector('[data-testid="automations-route-shell"]')).toBe(null);
  });

  test("automations route guards dirty template drafts but not unchanged template seeds", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-template-discard" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Templates" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("automation-template-daily-bug-scan") !== null).toBe(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("automation-template-daily-bug-scan"));
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Daily bug scan");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBe(null);
      expect(screen.container.querySelector('[data-testid="automation-detail-rail"]')).toBe(null);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Templates" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("automation-template-daily-bug-scan"));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
      promptInput.value = `${promptInput.value}\nAlso include CI failures.`;
      fireEvent.input(promptInput);
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
      await Promise.resolve();
    });
    const discardDialog = await screen.findByRole("dialog");
    expect(textContent(discardDialog).includes("Discard scheduled task draft?")).toBe(true);

    await act(async () => {
      fireEvent.click(within(discardDialog).getByRole("button", { name: "Keep editing" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBe(null);
      expect(
        screen.container.querySelector('[data-testid="automation-detail-rail"]') !== null,
      ).toBe(true);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
      await Promise.resolve();
    });
    const secondDiscardDialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(secondDiscardDialog).getByRole("button", { name: "Discard" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBe(null);
      expect(screen.container.querySelector('[data-testid="automation-detail-rail"]')).toBe(null);
      expect(textContent(screen.container).includes("Create your first scheduled task")).toBe(true);
    });
  });

  test("automations route exposes task row status and actions", async () => {
    installTerminalEventApiMock();
    const running = makeScheduledAutomation({
      id: "automation-running",
      name: "Running report",
      prompt: "Summarize the current report.",
      targetThreadId: "thread-running",
    });
    const active = makeScheduledAutomation({
      id: "automation-active",
      name: "Runnable task",
      prompt: "Run this on demand.",
      targetThreadId: "thread-active",
    });
    const paused = makeScheduledAutomation({
      id: "automation-paused",
      name: "Paused task",
      prompt: "Resume this later.",
      status: "PAUSED",
      targetThreadId: "thread-paused",
      nextRunAt: null,
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-row-actions" })],
      },
      scheduledAutomations: [running, active, paused],
      automationInboxItems: [
        makeAutomationInboxItem({
          id: "run-running",
          automationId: "automation-running",
          automationName: "Running report",
          status: "IN_PROGRESS",
          readAt: null,
          threadId: "thread-run-running",
        }),
      ],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(
        screen.container.querySelector('[data-testid="automations-route-shell"]') !== null,
      ).toBe(true);
      expect(textContent(screen.container).includes("Running report")).toBe(true);
    });
    await waitFor(() => {
      expect(
        textContent(screen.getByTestId("automation-list-row-automation-running")).includes(
          "In progress",
        ),
      ).toBe(true);
    });
    const runningRowText = textContent(
      screen.getByTestId("automation-list-row-automation-running"),
    );
    expect(runningRowText.includes("Chat")).toBe(true);
    expect(runningRowText.includes("Daily")).toBe(true);

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-active")).getByRole("button", {
          name: "Run now",
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getRunNowAutomationIds().length).toBe(1);
    });
    expect(screen.getRunNowAutomationIds()[0]).toBe("automation-active");
    expect(
      __getNodexToastSnapshotForTests().some(
        (record) =>
          record.kind === "plain" &&
          record.level === "info" &&
          record.title === "Scheduled task started",
      ),
    ).toBe(true);

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-active")).getByRole("button", {
          name: "Pause",
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      const saved = screen
        .getScheduledAutomations()
        .find((automation) => automation.id === "automation-active");
      expect(saved?.status).toBe("PAUSED");
    });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-paused")).getByRole("button", {
          name: "Resume",
        }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      const saved = screen
        .getScheduledAutomations()
        .find((automation) => automation.id === "automation-paused");
      expect(saved?.status).toBe("ACTIVE");
    });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-active")).getByRole("button", {
          name: "Delete",
        }),
      );
      await Promise.resolve();
    });
    const deleteDialog = await screen.findByRole("dialog");
    expect(textContent(deleteDialog).includes("Delete Runnable task?")).toBe(true);
    await act(async () => {
      fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete scheduled task" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const deleted =
        screen
          .getScheduledAutomations()
          .find((automation) => automation.id === "automation-active") ?? null;
      expect(deleted).toBe(null);
    });
  });

  test("automations route rolls back optimistic status updates when update fails", async () => {
    installTerminalEventApiMock();
    const active = makeScheduledAutomation({
      id: "automation-optimistic",
      name: "Optimistic task",
      prompt: "Pause this optimistically.",
      targetThreadId: "thread-optimistic",
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-optimistic" })],
      },
      scheduledAutomations: [active],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    await waitFor(() => {
      expect(
        screen.container.querySelector('[data-testid="automations-route-shell"]') !== null,
      ).toBe(true);
      expect(
        screen.container.querySelector(
          '[data-testid="automation-list-row-automation-optimistic"]',
        ) !== null,
      ).toBe(true);
    });

    let rejectUpdate: ((error: Error) => void) | null = null;
    const updatePromise = new Promise<never>((_resolve, reject) => {
      rejectUpdate = reject;
    });
    const baseMockInvokeImpl = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:scheduled-automations:update") {
        return await updatePromise;
      }
      return baseMockInvokeImpl?.(channel, ...args) ?? null;
    });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-optimistic")).getByRole(
          "button",
          { name: "Pause" },
        ),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("automation-list-row-automation-optimistic")).getByRole(
          "button",
          { name: "Resume" },
        ) !== null,
      ).toBe(true);
    });
    const backendAutomation = screen
      .getScheduledAutomations()
      .find((automation) => automation.id === "automation-optimistic");
    expect(backendAutomation?.status).toBe("ACTIVE");

    await act(async () => {
      rejectUpdate?.(new Error("Host update failed"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        within(screen.getByTestId("automation-list-row-automation-optimistic")).getByRole(
          "button",
          { name: "Pause" },
        ) !== null,
      ).toBe(true);
    });
    expect(
      __getNodexToastSnapshotForTests().some(
        (record) =>
          record.kind === "plain" &&
          record.level === "danger" &&
          record.title === "Could not update scheduled task" &&
          record.description === "Host update failed",
      ),
    ).toBe(true);
  });

  test("automations first-run suggestions pre-fill scheduled task chat prompts", async () => {
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-first-run-suggestion" })],
      },
      scheduledAutomations: [],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    const firstSuggestion = WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS[0];
    if (!firstSuggestion) throw new Error("Expected first-run suggestion fixture");
    const suggestionNames = WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS.map(
      (suggestion) => suggestion.name,
    ).join(",");
    const visibleSuggestionNames = WORKBENCH_AUTOMATION_FIRST_RUN_SUGGESTIONS.map(
      (suggestion) =>
        screen.getByRole("button", { name: suggestion.name }).textContent?.trim() ?? "",
    ).join(",");
    expect(visibleSuggestionNames).toBe(suggestionNames);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: firstSuggestion.name }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await waitFor(() => {
      expect(screen.container.querySelector('[data-testid="automations-route-shell"]')).toBe(null);
    });
    const promptInput = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
    await waitFor(() => {
      expect(promptInput.value).toBe(firstSuggestion.prompt);
    });
    expect(startThreadForSessionCalls.length).toBe(0);
  });

  test("automations route reports run-now host failures with the scheduled task toast title", async () => {
    installTerminalEventApiMock();
    const active = makeScheduledAutomation({
      id: "automation-active",
      name: "Runnable task",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      cwds: ["/Users/asc/repo/nodex"],
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/nodex")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-row-actions" })],
      },
      scheduledAutomations: [active],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    const baseMockInvokeImpl = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:scheduled-automations:run-now") {
        throw new Error("Automation is missing");
      }
      return baseMockInvokeImpl?.(channel, ...args) ?? null;
    });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-active")).getByRole("button", {
          name: "Run now",
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        __getNodexToastSnapshotForTests().some(
          (record) =>
            record.kind === "plain" &&
            record.level === "danger" &&
            record.title === "Could not start scheduled task" &&
            record.description === "Automation is missing",
        ),
      ).toBe(true);
    });
  });

  test("automations route reports delete failures with the scheduled task toast title", async () => {
    installTerminalEventApiMock();
    const active = makeScheduledAutomation({
      id: "automation-delete-failure",
      name: "Delete failure task",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      cwds: ["/Users/asc/repo/nodex"],
    });
    const screen = renderWorkbench({
      projects: [makeProject("alpha", "Alpha", "/Users/asc/repo/nodex")],
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-delete-failure" })],
      },
      scheduledAutomations: [active],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();
    const baseMockInvokeImpl = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:scheduled-automations:delete") {
        return {
          item: active,
          success: false,
          status: "remove_failed",
        };
      }
      return baseMockInvokeImpl?.(channel, ...args) ?? null;
    });

    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("automation-list-row-automation-delete-failure")).getByRole(
          "button",
          { name: "Delete" },
        ),
      );
      await Promise.resolve();
    });
    const deleteDialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(deleteDialog).getByRole("button", { name: "Delete scheduled task" }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(
        __getNodexToastSnapshotForTests().some(
          (record) =>
            record.kind === "plain" &&
            record.level === "danger" &&
            record.title === "Could not delete scheduled task" &&
            record.description === "Try again.",
        ),
      ).toBe(true);
    });
    expect(screen.getScheduledAutomations().length).toBe(1);
  });

  test("automations route renders previous runs with read, archive, unarchive, and delete actions", async () => {
    installTerminalEventApiMock();
    const automation = makeScheduledAutomation({
      id: "automation-history",
      kind: "cron",
      name: "History task",
      prompt: "Summarize the previous run history.",
      targetThreadId: null,
      model: "gpt-5",
      reasoningEffort: "low",
      cwds: ["/tmp/project-alpha"],
    });
    const screen = renderWorkbench({
      sessionsByProject: {
        alpha: [makeAttachedSession({ id: "session:alpha:automation-history" })],
      },
      scheduledAutomations: [automation],
      automationInboxItems: [
        makeAutomationInboxItem({
          id: "thread-run-latest",
          threadId: "thread-run-latest",
          automationId: "automation-history",
          automationName: "History task",
          title: "Latest history run",
          description: "Ready for review.",
          sourceCwd: "/tmp/project-alpha",
          createdAt: 300,
          readAt: null,
          status: "PENDING_REVIEW",
        }),
        makeAutomationInboxItem({
          id: "thread-run-archived",
          threadId: "thread-run-archived",
          automationId: "automation-history",
          automationName: "History task",
          title: "Archived history run",
          description: "Already archived.",
          sourceCwd: "/tmp/project-alpha",
          createdAt: 200,
          readAt: 50,
          status: "ARCHIVED",
        }),
        makeAutomationInboxItem({
          id: "thread-run-other",
          threadId: "thread-run-other",
          automationId: "automation-other",
          automationName: "Other task",
          title: "Other task run",
          createdAt: 400,
        }),
      ],
    });
    await settleAsyncRender();
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Scheduled" }));
      await Promise.resolve();
    });
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(screen.getByTestId("automation-list-row-automation-history"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(textContent(screen.container).includes("Previous runs")).toBe(true);
      expect(textContent(screen.container).includes("Latest history run")).toBe(true);
      expect(textContent(screen.container).includes("Archived history run")).toBe(true);
      expect(textContent(screen.container).includes("project-alpha")).toBe(true);
      expect(textContent(screen.container).includes("Other task run")).toBe(false);
    });

    await act(async () => {
      fireEvent.mouseDown(screen.getByLabelText("Previous runs actions"), {
        button: 0,
        ctrlKey: false,
      });
      await Promise.resolve();
    });
    const markAllRead = await screen.findByRole("menuitem", { name: "Mark all as read" });
    await act(async () => {
      fireEvent.click(markAllRead);
      await Promise.resolve();
    });
    await waitFor(() => {
      const latest = screen
        .getAutomationInboxItems()
        .find((item) => item.threadId === "thread-run-latest");
      expect(latest?.readAt !== null).toBe(true);
    });

    await act(async () => {
      const latestRun = within(
        screen.getByTestId("automation-previous-run-thread-run-latest"),
      ).getByRole("button", { name: "Latest history run" });
      fireEvent.contextMenu(latestRun);
      await Promise.resolve();
    });
    const archiveItem = await screen.findByRole("menuitem", { name: "Archive" });
    await act(async () => {
      fireEvent.click(archiveItem);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Archive 1 run?" }) !== null).toBe(true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const latest = screen
        .getAutomationInboxItems()
        .find((item) => item.threadId === "thread-run-latest");
      expect(latest?.status).toBe("ARCHIVED");
    });

    await act(async () => {
      const archivedRun = within(
        screen.getByTestId("automation-previous-run-thread-run-archived"),
      ).getByRole("button", { name: "Archived history run" });
      fireEvent.contextMenu(archivedRun);
      await Promise.resolve();
    });
    const unarchiveItem = await screen.findByRole("menuitem", { name: "Unarchive" });
    expect(screen.queryByRole("menuitem", { name: "Delete" })).toBe(null);
    await act(async () => {
      fireEvent.click(unarchiveItem);
      await Promise.resolve();
    });
    await waitFor(() => {
      const archived = screen
        .getAutomationInboxItems()
        .find((item) => item.threadId === "thread-run-archived");
      expect(archived?.status).toBe("ACCEPTED");
    });

    await act(async () => {
      fireEvent.mouseDown(screen.getByLabelText("Previous runs actions"), {
        button: 0,
        ctrlKey: false,
      });
      await Promise.resolve();
    });
    const archiveAllItem = await screen.findByRole("menuitem", { name: "Archive all" });
    await act(async () => {
      fireEvent.click(archiveAllItem);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Archive 1 run?" }) !== null).toBe(true);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      const archived = screen
        .getAutomationInboxItems()
        .find((item) => item.threadId === "thread-run-archived");
      expect(archived?.status).toBe("ARCHIVED");
      expect(
        __getNodexToastSnapshotForTests().some(
          (record) =>
            record.kind === "plain" &&
            record.level === "success" &&
            record.title === "Archived 1 run",
        ),
      ).toBe(true);
    });
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

    expect(startThreadForSessionCalls.length).toBe(1);
    expect(JSON.stringify(startThreadForSessionCalls[0])).toBe(
      JSON.stringify({
        projectId: "alpha",
        sessionId: "session:alpha:blank",
        prompt: "Start from session",
        runInTarget: "localProject",
        runInEnvironmentPath: null,
        collaborationMode: "default",
        browserUsePresentationOrigin: {
          browserConversationId: "session:alpha:blank",
          browserViewScopeId: "window-session:test",
        },
      }),
    );
    expect(
      invokeCalls.some((call) => call[0] === "workspace:tasks:list" && call[1] === "alpha"),
    ).toBe(true);
  });

  test("inline message edit calls rollback edit without refreshing source-null snapshot or seeding composer intent", async () => {
    renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    const onEditLastUserTurn = actions.onEditLastUserTurn as
      | ((input: { threadId: string; turnId: string; message: string }) => Promise<void>)
      | undefined;
    expect(typeof onEditLastUserTurn).toBe("function");

    await act(async () => {
      await onEditLastUserTurn?.({
        threadId: "thread-alpha",
        turnId: "turn-latest",
        message: "Rewrite the latest prompt",
      });
    });
    await settleAsyncRender();

    expect(JSON.stringify(editLastUserTurnCalls)).toBe(
      JSON.stringify([["thread-alpha", "turn-latest", "Rewrite the latest prompt"]]),
    );
    expect(JSON.stringify(requestThreadStreamSnapshotCalls)).toBe(JSON.stringify([]));
    expect(setComposerIntentCalls.length).toBe(0);
  });

  test("session thread actions wire queued follow-up, plan, and background terminal commands", async () => {
    renderWorkbench({
      sessionsByProject: { alpha: [makeAttachedSession()] },
    });
    await settleAsyncRender();
    await settleAsyncRender();

    const actions = getLastThreadStageActions();
    for (const actionName of [
      "onRemoveQueuedFollowUp",
      "onReorderQueuedFollowUps",
      "onSendQueuedFollowUpNow",
      "onEditQueuedFollowUp",
      "onResolvePlanImplementationRequest",
      "onCleanBackgroundTerminals",
    ]) {
      expect(typeof actions[actionName]).toBe("function");
    }

    await act(async () => {
      await (
        actions.onRemoveQueuedFollowUp as (threadId: string, followUpId: string) => Promise<void>
      )("thread-alpha", "follow-1");
      await (
        actions.onReorderQueuedFollowUps as (
          threadId: string,
          orderedFollowUpIds: string[],
        ) => Promise<void>
      )("thread-alpha", ["follow-2", "follow-1"]);
      await (
        actions.onSendQueuedFollowUpNow as (threadId: string, followUpId: string) => Promise<void>
      )("thread-alpha", "follow-2");
      await (
        actions.onEditQueuedFollowUp as (input: {
          threadId: string;
          followUpId: string;
          prompt: string;
          promptInput?: unknown;
          ledgerRevision?: number;
        }) => Promise<void>
      )({
        threadId: "thread-alpha",
        followUpId: "follow-3",
        prompt: "Edit queued message",
        ledgerRevision: 7,
        promptInput: {
          text: "Edit queued message",
          mentions: [{ name: "README.md", path: "/repo/README.md" }],
        },
      });
      await (
        actions.onResolvePlanImplementationRequest as (
          threadId: string,
          turnId: string,
        ) => Promise<void>
      )("thread-alpha", "turn-plan");
      await (actions.onCleanBackgroundTerminals as (threadId: string) => Promise<void>)(
        "thread-alpha",
      );
    });
    await settleAsyncRender();

    expect(JSON.stringify(removeQueuedFollowUpCalls)).toBe(
      JSON.stringify([["thread-alpha", "follow-1"]]),
    );
    expect(JSON.stringify(reorderQueuedFollowUpsCalls)).toBe(
      JSON.stringify([["thread-alpha", ["follow-2", "follow-1"]]]),
    );
    expect(JSON.stringify(sendQueuedFollowUpNowCalls)).toBe(
      JSON.stringify([["thread-alpha", "follow-2"]]),
    );
    expect(JSON.stringify(setComposerIntentCalls)).toBe(
      JSON.stringify([
        [
          "thread-alpha",
          {
            prompt: "Edit queued message",
            promptInput: {
              text: "Edit queued message",
              mentions: [{ name: "README.md", path: "/repo/README.md" }],
            },
            queuedFollowUpEdit: { followUpId: "follow-3", ledgerRevision: 7 },
            focusNonce: (setComposerIntentCalls[0]?.[1] as { focusNonce?: number } | undefined)
              ?.focusNonce,
          },
        ],
      ]),
    );
    expect(JSON.stringify(removePlanImplementationRequestCalls)).toBe(
      JSON.stringify([["thread-alpha", "turn-plan"]]),
    );
    expect(JSON.stringify(cleanBackgroundTerminalsCalls)).toBe(JSON.stringify(["thread-alpha"]));
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
    expect(startThreadForSessionCalls.length).toBe(1);
    const betaSessionId = rendererCommandPayload(
      invokeCalls.find(
        (call) =>
          call[0] === "project-sessions:ensure-default-draft" &&
          rendererCommandPayload(call)?.projectId === "beta",
      ),
    )?.candidateSessionId;
    expect(JSON.stringify(startThreadForSessionCalls[0])).toBe(
      JSON.stringify({
        projectId: "beta",
        sessionId: betaSessionId,
        prompt: "Start from session",
        runInTarget: "localProject",
        runInEnvironmentPath: null,
        collaborationMode: "default",
        browserUsePresentationOrigin: {
          browserConversationId: betaSessionId,
          browserViewScopeId: "window-session:test",
        },
      }),
    );
    expect(
      invokeCalls.some((call) => call[0] === "workspace:tasks:list" && call[1] === "beta"),
    ).toBe(true);
  });

  test("session composer submit passes the selected new-worktree target", async () => {
    setStartThreadForSessionResult({
      kind: "pending",
      pendingWorktreeId: "local:pending-session-composer",
      clientThreadId: "client-new-thread:pending-session-composer",
    });
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

    expect(startThreadForSessionCalls.length).toBe(1);
    expect(JSON.stringify(startThreadForSessionCalls[0])).toBe(
      JSON.stringify({
        projectId: "alpha",
        sessionId: "session:alpha:blank",
        prompt: "Start from session",
        runInTarget: "newWorktree",
        runInEnvironmentPath: null,
        collaborationMode: "default",
        browserUsePresentationOrigin: {
          browserConversationId: "session:alpha:blank",
          browserViewScopeId: "window-session:test",
        },
      }),
    );
    expect(screen.getByTestId("pending-worktree-route-shell") !== null).toBe(true);
    expect(
      invokeCalls.filter((call) => call[0] === "project-sessions:list" && call[1] === "alpha")
        .length,
    ).toBe(sessionRefreshCountBeforeSubmit);
  });
});
