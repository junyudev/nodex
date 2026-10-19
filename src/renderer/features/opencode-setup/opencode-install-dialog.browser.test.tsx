import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { AgentIntelligenceDropdown } from "@/components/shared/agent-runtime/agent-intelligence-dropdown";
import type { AgentModelPickerEntry } from "@/components/shared/agent-runtime/agent-model-picker";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { catalogModel } from "@/lib/agent-model-catalog.test-fixtures";
import { MaitaiProvider, createMaitaiStore } from "@/lib/maitai";
import { NodexModalHost } from "@/lib/modal-registry";
import { installRendererThemeFixture } from "@/test/renderer-theme";
import "../../globals.css";
import { createOpenCodeSetupOwner, type OpenCodeSetupOwner } from "./opencode-setup-owner";
import {
  OPENCODE_INSTALL_COMMAND,
  fakeSetupRuntime,
  readyExecutable,
  setupState,
} from "./opencode-setup.test-fixtures";
import { useOpenCodeModelSetup } from "./use-opencode-setup";

installRendererThemeFixture();

const codex = { kind: "codex" } as const;
const opencode = { kind: "opencode", instanceConfigId: "opencode-default" } as const;
const chosenModel = catalogModel("gpt-sol", "GPT Sol");
const freeModel = catalogModel("opencode/glm-5.3-flash-free", "GLM Flash Free");
const chosen = { binding: codex, model: chosenModel.id };
const hostProfiles = [
  { binding: opencode, label: "OpenCode", enabled: true, usesHostExecutable: true },
];
const installed: AgentModelPickerEntry[] = [
  { binding: codex, label: "Codex", model: chosenModel, selection: chosen },
];

/** The composer's model menu with host OpenCode setup; readiness reloads the catalog. */
function ComposerModelMenu({ owner }: { readonly owner: OpenCodeSetupOwner }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState(installed);
  const { setup } = useOpenCodeModelSetup({
    instances: hostProfiles,
    owner,
    onReady: () =>
      setEntries([
        ...installed,
        {
          binding: opencode,
          label: "OpenCode",
          model: freeModel,
          selection: { binding: opencode, model: freeModel.id },
        },
      ]),
  });
  return (
    <div style={{ position: "fixed", right: 40, bottom: 40 }}>
      <AgentIntelligenceDropdown
        models={[chosenModel]}
        open={open}
        onOpenChange={setOpen}
        selection={{
          kind: "codex",
          model: chosen.model,
          reasoningEffort: "none",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Codex",
          selection: "codex",
          options: [],
          select: () => {},
          modelCatalog: {
            entries,
            selected: chosen,
            loading: false,
            choose: () => {},
            refresh: () => {},
            manage: () => {},
            setup,
          },
        }}
      />
    </div>
  );
}

/** The rendered box of one line inside the log's single preformatted text run. */
function lineBox(dialog: HTMLElement, text: string) {
  const node = [...dialog.querySelectorAll("*")]
    .flatMap((element) => [...element.childNodes])
    .find((child): child is Text => child instanceof Text && child.data.includes(text));
  if (!node) throw new Error(`Missing output line ${text}`);
  const range = document.createRange();
  range.setStart(node, node.data.indexOf(text));
  range.setEnd(node, node.data.indexOf(text) + text.length);
  const scroller = node.parentElement!.closest<HTMLElement>(".overflow-y-auto");
  if (!scroller) throw new Error("The installer log must scroll within its own bound");
  return { box: range.getBoundingClientRect(), viewport: scroller.getBoundingClientRect() };
}

test("moves from a fruitless model search to the installer and back to fresh free models", async () => {
  const main = fakeSetupRuntime(setupState(1));
  const lines = Array.from(
    { length: 40 },
    (_, index) => `step ${String(index + 1).padStart(2, "0")}`,
  );
  main.runtime.install.mockImplementation(async () => {
    const running = setupState(2, {
      installation: { phase: "running", log: { lines, progress: 0.42 } },
    });
    main.set(running);
    return running;
  });
  const owner = createOpenCodeSetupOwner(main.runtime, vi.fn());
  render(
    <MaitaiProvider store={createMaitaiStore()}>
      <NodexTooltipProvider delay={0}>
        <ComposerModelMenu owner={owner} />
        <NodexModalHost />
      </NodexTooltipProvider>
    </MaitaiProvider>,
  );

  const trigger = screen.getByRole("button", { name: "Select model" });
  await act(async () => userEvent.click(trigger));
  const initialSearch = await screen.findByRole("combobox", { name: "Search models" });
  await act(async () => userEvent.type(initialSearch, "free"));
  await screen.findByText("No matching models");
  const installModels = await screen.findByRole("button", { name: "Free OpenCode models Install" });
  await act(async () => userEvent.click(installModels));

  // The menu closes before the dialog takes focus; opening shows the command without running it.
  const dialog = await screen.findByRole("dialog", { name: "Install OpenCode" });
  expect(screen.queryByRole("listbox")).toBeNull();
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  await within(dialog).findByText(`$ ${OPENCODE_INSTALL_COMMAND}`);
  expect(main.runtime.install).not.toHaveBeenCalled();

  await act(async () => userEvent.click(within(dialog).getByRole("button", { name: "Install" })));
  const progress = await within(dialog).findByRole("progressbar", {
    name: "Installation progress",
  });
  await waitFor(() => {
    const newest = lineBox(dialog, "step 40");
    expect(newest.box.top).toBeGreaterThanOrEqual(newest.viewport.top);
    expect(newest.box.bottom).toBeLessThanOrEqual(newest.viewport.bottom + 1);
    const fill = progress.firstElementChild!.getBoundingClientRect().width;
    expect(fill / progress.getBoundingClientRect().width).toBeCloseTo(0.42, 2);
  });

  await act(async () => {
    main.emit(
      setupState(3, {
        executable: readyExecutable(),
        installation: { phase: "succeeded", log: { lines, progress: 1 } },
      }),
    );
  });
  const showModels = await within(dialog).findByRole("button", { name: "Show free models" });
  await act(async () => userEvent.click(showModels));

  // Focus returns to the reopened menu's empty search, beside the new model and the same choice.
  const search = await screen.findByRole("combobox", { name: "Search models" });
  await waitFor(() => expect(document.activeElement).toBe(search));
  expect(screen.queryByRole("dialog", { name: "Install OpenCode" })).toBeNull();
  expect((search as HTMLInputElement).value).toBe("");
  await screen.findByRole("option", { name: /GLM Flash Free/ });
  expect(screen.getByRole("option", { name: /GPT Sol/ }).getAttribute("aria-selected")).toBe(
    "true",
  );
});
