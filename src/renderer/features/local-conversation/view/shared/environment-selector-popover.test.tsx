import { describe, expect, test } from "vite-plus/test";
import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import type { WorktreeEnvironmentConfigRecord } from "@/lib/types";
import { render, settleAsyncRender } from "@/test/dom";
import { EnvironmentSelectorPopover } from "./environment-selector-popover";

function config(
  configPath: string,
  name: string,
  state: WorktreeEnvironmentConfigRecord["state"] = "success",
): WorktreeEnvironmentConfigRecord {
  return {
    configPath,
    fileName: configPath.split("/").at(-1) ?? name,
    state,
    exists: true,
    name,
    hasSetupScript: state === "success",
    hasCleanupScript: false,
    actionCount: 0,
    parseErrorMessage: state === "parseError" ? "Invalid TOML" : null,
    readErrorMessage: null,
    tooLargeMessage: null,
    environment: null,
  };
}

async function openMenu(view: ReturnType<typeof render>): Promise<void> {
  await act(async () => {
    const trigger = view.getByLabelText("Select worktree environment");
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    await settleAsyncRender();
  });
}

describe("environment selector popover", () => {
  test("renders the default, explicit no-environment, and settings choices", async () => {
    const selected: Array<string | null> = [];
    const view = render(
      <NodexTooltipProvider>
        <EnvironmentSelectorPopover
          busy={false}
          configs={[
            config(".codex/environments/environment.toml", "Default"),
            config(".codex/environments/test.toml", "Tests"),
          ]}
          defaultPath=".codex/environments/environment.toml"
          selectedPath=".codex/environments/environment.toml"
          onRefresh={async () => {}}
          onSelect={(value) => {
            selected.push(value);
            return true;
          }}
          onOpenSettings={() => undefined}
        />
      </NodexTooltipProvider>,
    );

    await openMenu(view);
    expect(document.body.textContent).toContain("Environment");
    expect(document.body.textContent).toContain("Work without environment");
    expect(document.body.textContent).toContain("Default");
    expect(document.body.textContent).toContain("Tests");
    expect(document.body.textContent).toContain("Environment settings");

    await act(async () => {
      fireEvent.click(view.getByText("Work without environment"));
      await settleAsyncRender();
    });
    expect(selected).toEqual([null]);
  });

  test("keeps an invalid saved environment in needs-attention state and repairs through settings", async () => {
    const openedSettings: Array<string | null | undefined> = [];
    const invalidPath = ".codex/environments/broken.toml";
    const view = render(
      <NodexTooltipProvider>
        <EnvironmentSelectorPopover
          busy={false}
          configs={[config(invalidPath, "Broken", "parseError")]}
          needsAttention
          repairConfigPath={invalidPath}
          selectedPath={null}
          onRefresh={async () => {}}
          onSelect={() => true}
          onOpenSettings={(value) => {
            openedSettings.push(value);
          }}
        />
      </NodexTooltipProvider>,
    );

    expect(view.getByLabelText("Select worktree environment").textContent).toContain(
      "Needs attention",
    );
    await openMenu(view);
    expect(document.body.textContent).toContain("Needs attention");
    expect(document.body.textContent).not.toContain("Repair Broken");

    await act(async () => {
      fireEvent.click(view.getByText("Environment settings"));
      await settleAsyncRender();
    });
    expect(openedSettings).toEqual([invalidPath]);
  });

  test("qualifies the title with the primary repository for multi-root projects", async () => {
    const view = render(
      <NodexTooltipProvider>
        <EnvironmentSelectorPopover
          busy={false}
          configs={[]}
          repositoryName="nodex"
          showRepositoryName
          onRefresh={async () => {}}
          onSelect={() => true}
          onOpenSettings={() => undefined}
        />
      </NodexTooltipProvider>,
    );

    await openMenu(view);
    expect(document.body.textContent).toContain("Environment · nodex");
  });
  test("does not show an empty state alongside the sole matching default environment", async () => {
    const view = render(
      <NodexTooltipProvider>
        <EnvironmentSelectorPopover
          busy={false}
          configs={[config("default.toml", "Development")]}
          defaultPath="default.toml"
          onRefresh={async () => {}}
          onSelect={() => true}
          onOpenSettings={() => {}}
        />
      </NodexTooltipProvider>,
    );
    await openMenu(view);
    expect(view.getByRole("menuitem", { name: "Development" })).toBeTruthy();
    expect(view.queryByText("No environments found")).toBeNull();
    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Search environments" }), {
        target: { value: "Development" },
      });
      await Promise.resolve();
    });
    expect(view.getByRole("menuitem", { name: "Development" })).toBeTruthy();
    expect(view.queryByText("No environments found")).toBeNull();
  });
});
