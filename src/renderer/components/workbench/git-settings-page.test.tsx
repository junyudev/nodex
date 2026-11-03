import { deferred } from "./agent-instance-settings.test-fixtures";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { GitSettingsPage } from "./git-settings-page";
import type { SettingsSectionPageProps } from "./workbench-settings-page-registry";

const settings = vi.hoisted(() => ({
  branchPrefix: "codex/",
  commitInstructions: "First instructions",
  pullRequestInstructions: "",
}));
const updateGitSettings = vi.hoisted(() => vi.fn());
vi.mock("./workbench-settings-overlay-deps", () => ({
  readGitSettings: async () => ({ ...settings }),
  updateGitSettings,
  readDiagnosticsSettings: vi.fn(),
  readTelemetrySettings: vi.fn(),
  updateDiagnosticsSettings: vi.fn(),
  updateTelemetrySettings: vi.fn(),
}));

beforeEach(() => {
  settings.commitInstructions = "First instructions";
  updateGitSettings.mockReset();
  updateGitSettings.mockImplementation(async () => ({ ...settings }));
});

const props: SettingsSectionPageProps = {
  activeProjectId: null,
  browserAnchor: null,
  browserDetail: null,
  composerEnterBehavior: "enter",
  isMacPlatform: true,
  onComposerEnterBehaviorChange: () => undefined,
  onOpenBrowserDetail: () => undefined,
  onPathChange: () => undefined,
  onRequestProjectPickerOpen: () => undefined,
  onTaskShorthandPagePromotionEnabledChange: () => undefined,
  onThreadQueueFollowUpsEnabledChange: () => undefined,
  onWorktreeAutoBranchPrefixChange: () => undefined,
  onWorktreeStartModeChange: () => undefined,
  open: true,
  path: "/settings/git",
  projects: [],
  taskShorthandPagePromotionEnabled: true,
  threadQueueFollowUpsEnabled: false,
  worktreeAutoBranchPrefix: "codex/",
  worktreeStartMode: "autoBranch",
};

test("replaces an unsaved instruction draft when reopened settings supply a new value", async () => {
  const page = (open: boolean) => (
    <StrictMode>
      <GitSettingsPage {...props} open={open} />
    </StrictMode>
  );
  const view = render(page(true));
  const input = view.getByRole("textbox", { name: "Commit instructions" });
  await waitFor(() => expect(input).toHaveProperty("value", "First instructions"));
  await act(async () => {
    fireEvent.change(input, { target: { value: "Unsaved draft" } });
    await Promise.resolve();
  });
  expect(input).toHaveProperty("value", "Unsaved draft");
  view.rerender(page(false));
  settings.commitInstructions = "Updated instructions";
  view.rerender(page(true));
  await waitFor(() => expect(input).toHaveProperty("value", "Updated instructions"));
});

test.each(["saved", "failed"])(
  "keeps instruction editing disabled until a save has %s",
  async (outcome) => {
    const action = deferred<typeof settings>();
    updateGitSettings.mockReturnValueOnce(action.promise);
    const view = render(<GitSettingsPage {...props} />);
    const input = view.getByRole("textbox", { name: "Commit instructions" });
    await waitFor(() => expect(input).toHaveProperty("value", "First instructions"));
    await act(async () => {
      fireEvent.change(input, { target: { value: "Updated instructions" } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getAllByRole("button", { name: "Save" })[0]!);
      await Promise.resolve();
    });
    expect(updateGitSettings).toHaveBeenCalledWith({ commitInstructions: "Updated instructions" });
    expect(input).toHaveProperty("disabled", true);

    await act(async () => {
      if (outcome === "failed") action.reject(new Error("Save failed"));
      else action.resolve({ ...settings, commitInstructions: "Updated instructions" });
      await Promise.resolve();
    });
    await waitFor(() => expect(input).toHaveProperty("disabled", false));
    expect(input).toHaveProperty("value", "Updated instructions");
    expect(view.getAllByRole("button", { name: "Save" })[0]).toHaveProperty(
      "disabled",
      outcome === "saved",
    );
  },
);
