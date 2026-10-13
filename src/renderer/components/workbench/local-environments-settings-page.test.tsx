import { act, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexSettingsPageSurface } from "@/components/ui/settings";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { installWindowApi } from "@/test/browser-globals";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import type {
  Project,
  UpdateWorktreeEnvironmentConfigInput,
  WorktreeEnvironmentSaveResult,
  WorktreeEnvironmentSettingsSnapshot,
} from "@/lib/types";
import { LocalEnvironmentsSettingsPage } from "./local-environments-settings-page";

vi.mock("@/components/ui/lazy-source-viewer", () => ({
  LazySourceViewer: ({ value, ariaLabel }: { value: string; ariaLabel: string }) => (
    <pre aria-label={ariaLabel}>{value}</pre>
  ),
}));

const PROJECT: Project = {
  id: "project-alpha",
  libraryId: "library:test",
  databaseId: "database:test:primary",
  defaultDatabaseViewId: "view:test:primary",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Alpha",
  description: "",
  appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
  sources: [{ root: "/tmp/alpha", order: 0 }],
  primaryWorkspaceRoot: "/tmp/alpha",
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-03-01T00:00:00.000Z"),
  updated: new Date("2026-03-01T00:00:00.000Z"),
};

function buildSnapshot(
  overrides: Partial<WorktreeEnvironmentSettingsSnapshot> = {},
): WorktreeEnvironmentSettingsSnapshot {
  const environment = {
    version: 1,
    name: "Alpha environment",
    setup: {
      script: "default setup",
      platformScripts: { linux: "linux setup" },
    },
    cleanup: { script: null, platformScripts: {} },
    actions: [
      {
        name: "Run tests",
        icon: "test" as const,
        command: "bun test\n--watch",
        platform: null,
      },
    ],
  };
  const config = {
    configPath: ".codex/environments/environment.toml",
    fileName: "environment.toml",
    state: "success" as const,
    exists: true,
    name: environment.name,
    hasSetupScript: true,
    hasCleanupScript: false,
    actionCount: 1,
    parseErrorMessage: null,
    readErrorMessage: null,
    environment,
  };
  return {
    projectId: PROJECT.id,
    projectName: PROJECT.name,
    workspacePath: PROJECT.primaryWorkspaceRoot ?? "",
    configPath: config.configPath,
    nextConfigPath: ".codex/environments/environment-2.toml",
    configExists: true,
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    configs: [config],
    environment,
    parseErrorMessage: null,
    readErrorMessage: null,
    ...overrides,
  };
}

function renderPage() {
  return render(
    <TestQueryProvider>
      <NodexTooltipProvider>
        <LocalEnvironmentsSettingsPage
          open
          active
          projects={[PROJECT]}
          activeProjectId={PROJECT.id}
          initialProjectId={PROJECT.id}
          initialConfigPath=".codex/environments/environment.toml"
          renderShell={({ title, subtitle, backSlot, action, children }) => (
            <NodexSettingsPageSurface
              title={title}
              subtitle={subtitle}
              backSlot={backSlot}
              action={action}
            >
              {children}
            </NodexSettingsPageSurface>
          )}
        />
      </NodexTooltipProvider>
    </TestQueryProvider>,
  );
}

describe("LocalEnvironmentsSettingsPage", () => {
  let snapshot: WorktreeEnvironmentSettingsSnapshot;
  let saveResult: WorktreeEnvironmentSaveResult;
  let saveInputs: UpdateWorktreeEnvironmentConfigInput[];
  let readCalls: number;
  let failReadsAfterSave: boolean;
  let saveOperation: (() => Promise<WorktreeEnvironmentSaveResult>) | null;

  beforeEach(() => {
    snapshot = buildSnapshot();
    saveResult = { type: "success" };
    saveInputs = [];
    readCalls = 0;
    failReadsAfterSave = false;
    saveOperation = null;
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "worktrees:environments:config:read") {
          readCalls += 1;
          if (failReadsAfterSave && saveInputs.length > 0) {
            throw new Error("Snapshot refresh failed");
          }
          return snapshot;
        }
        if (channel === "worktrees:environments:config:save") {
          saveInputs.push(args[0] as UpdateWorktreeEnvironmentConfigInput);
          if (saveOperation) return saveOperation();
          return saveResult;
        }
        if (channel === "worktrees:environments:configs:list") return snapshot.configs;
        if (channel === "worktrees:environments:list") return [];
        throw new Error(`Unexpected channel: ${channel}`);
      },
    });
  });

  test("renders the environment-name summary with platform fallback and action disclosure", async () => {
    const view = renderPage();
    expect(await view.findByRole("heading", { level: 1, name: "Alpha environment" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Edit local environment" })).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "macOS" }));
    expect(view.getByText("No platform override. Using the default script")).toBeTruthy();
    expect(view.getByLabelText("Setup script").textContent).toContain("default setup");

    const disclosure = view.getByRole("button", { name: "Show full command for Run tests" });
    fireEvent.click(disclosure);
    expect(view.getByRole("button", { name: "Hide full command for Run tests" })).toBeTruthy();
    expect(document.getElementById(disclosure.getAttribute("aria-controls")!)?.textContent).toBe(
      "bun test\n--watch",
    );
  });

  test("gates every submit path and saves with the snapshot revision", async () => {
    const view = renderPage();
    fireEvent.click(await view.findByRole("button", { name: "Edit local environment" }));

    const save = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      fireEvent.submit(save.closest("form")!);
      await Promise.resolve();
    });
    expect(saveInputs).toHaveLength(0);

    const name = view.getAllByRole("textbox", { name: "Name" })[0]!;
    fireEvent.change(name, { target: { value: "Updated environment" } });
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveInputs).toHaveLength(1));
    expect(saveInputs[0]).toMatchObject({
      projectId: PROJECT.id,
      configPath: ".codex/environments/environment.toml",
      expectedRevision: snapshot.revision,
      environment: { name: "Updated environment" },
    });
  });

  test("distinguishes blank actions from incomplete actions", async () => {
    const view = renderPage();
    fireEvent.click(await view.findByRole("button", { name: "Edit local environment" }));
    fireEvent.click(view.getByRole("button", { name: "Add action" }));

    const actionNames = view.getAllByRole("textbox", { name: "Name" });
    const blankName = actionNames.at(-1)!;
    expect(blankName.getAttribute("aria-invalid")).toBe("false");
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.change(blankName, { target: { value: "Deploy" } });
    expect(view.getByText("Enter an action command")).toBeTruthy();
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("returns focus after closing Variables and the action icon menu with Escape", async () => {
    const view = renderPage();
    fireEvent.click(await view.findByRole("button", { name: "Edit local environment" }));

    const variables = view.getByRole("button", { name: "Variables" });
    fireEvent.click(variables);
    const dialog = await view.findByRole("dialog", { name: "Setup script environment variables" });
    await act(async () => {
      dialog.focus();
      fireEvent.keyDown(document, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement).toBe(variables));

    const iconTrigger = view.getByRole("button", { name: "Test" });
    await act(async () => {
      fireEvent.pointerDown(iconTrigger, { button: 0, ctrlKey: false });
      fireEvent.mouseDown(iconTrigger, { button: 0, ctrlKey: false });
      fireEvent.click(iconTrigger);
      await Promise.resolve();
    });
    await view.findByRole("menu");
    expect(view.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Tool",
      "Run",
      "Debug",
      "Test",
    ]);
    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement).toBe(iconTrigger));
  });

  test("keeps the draft on conflict and only refetches after explicit discard", async () => {
    saveResult = { type: "conflict" };
    const view = renderPage();
    fireEvent.click(await view.findByRole("button", { name: "Edit local environment" }));
    fireEvent.change(view.getAllByRole("textbox", { name: "Name" })[0]!, {
      target: { value: "My draft" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    expect(
      await view.findByText(
        "This environment changed on disk. Continuing will discard your unsaved edits",
      ),
    ).toBeTruthy();
    expect((view.getAllByRole("textbox", { name: "Name" })[0] as HTMLInputElement).value).toBe(
      "My draft",
    );
    const callsBeforeDiscard = readCalls;

    snapshot = buildSnapshot({
      revision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      environment: { ...snapshot.environment!, name: "External environment" },
    });
    fireEvent.click(view.getByRole("button", { name: "Discard edits" }));

    expect(
      await view.findByRole("heading", { level: 1, name: "External environment" }),
    ).toBeTruthy();
    expect(readCalls).toBeGreaterThan(callsBeforeDiscard);
  });

  test("does not report a disk save as failed when selecting the refreshed snapshot fails", async () => {
    failReadsAfterSave = true;
    const view = renderPage();
    fireEvent.click(await view.findByRole("button", { name: "Edit local environment" }));
    fireEvent.change(view.getAllByRole("textbox", { name: "Name" })[0]!, {
      target: { value: "Saved environment" },
    });
    fireEvent.click(view.getByRole("button", { name: "Save" }));

    expect(
      await view.findAllByText("Saved the environment file, but could not select it"),
    ).not.toHaveLength(0);
    expect(view.getByRole("button", { name: "Retry loading" })).toBeTruthy();
    expect(saveInputs).toHaveLength(1);

    failReadsAfterSave = false;
    snapshot = buildSnapshot({
      revision: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      environment: { ...snapshot.environment!, name: "Saved environment" },
    });
    fireEvent.click(view.getByRole("button", { name: "Retry loading" }));

    expect(await view.findByRole("heading", { level: 1, name: "Saved environment" })).toBeTruthy();
    expect(saveInputs).toHaveLength(1);
  });

  test("retains a failed save draft and prevents duplicate submission during its retry", async () => {
    saveOperation = async () => {
      throw new Error("Environment file could not be written");
    };
    const view = renderPage();
    await act(async () => {
      fireEvent.click(await view.findByRole("button", { name: "Edit local environment" }));
      await Promise.resolve();
    });
    const name = view.getAllByRole("textbox", { name: "Name" })[0] as HTMLInputElement;
    await act(async () => {
      fireEvent.change(name, { target: { value: "Retained environment" } });
      fireEvent.click(view.getByRole("button", { name: "Save" }));
      await Promise.resolve();
    });
    const retry = await view.findByRole("button", { name: "Retry save" });
    expect(name.value).toBe("Retained environment");
    expect(saveInputs).toHaveLength(1);

    let finishSave: ((result: WorktreeEnvironmentSaveResult) => void) | undefined;
    saveOperation = () =>
      new Promise((resolve) => {
        finishSave = resolve;
      });
    await act(async () => {
      fireEvent.click(retry);
      await Promise.resolve();
    });
    const save = await view.findByRole("button", { name: "Save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(save.closest("form")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      fireEvent.submit(save.closest("form")!);
      await Promise.resolve();
    });
    expect(saveInputs).toHaveLength(2);
    expect(saveInputs[1]).toEqual(saveInputs[0]);

    snapshot = buildSnapshot({
      environment: { ...snapshot.environment!, name: "Retained environment" },
    });
    await act(async () => {
      finishSave?.({ type: "success" });
      await Promise.resolve();
    });
    await view.findByRole("heading", { level: 1, name: "Retained environment" });
    expect(saveInputs).toHaveLength(2);
  });

  test("keeps oversized files non-editable", async () => {
    snapshot = buildSnapshot({
      revision: null,
      environment: null,
      tooLargeMessage: "Environment file exceeds 262,144 bytes",
      configs: [
        {
          ...buildSnapshot().configs[0]!,
          state: "tooLarge",
          environment: null,
          tooLargeMessage: "Environment file exceeds 262,144 bytes",
        },
      ],
    });
    const view = renderPage();

    expect(await view.findByText("Environment file exceeds 262,144 bytes")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Edit local environment" })).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
  });
});
