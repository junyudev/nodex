import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithMaitai } from "@/test/thread-maitai";
import { catalogModel } from "@/lib/agent-model-catalog.test-fixtures";
import { AgentIntelligenceDropdown } from "./agent-intelligence-dropdown";
import type { AgentModelCatalogPresentation } from "./agent-model-picker";

const model = catalogModel("moonshot/kimi-k3", "Kimi K3");
const selected = {
  binding: { kind: "opencode", instanceConfigId: "local" },
  model: model.id,
} as const;
function Picker({ catalog }: { readonly catalog: AgentModelCatalogPresentation }) {
  return (
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[model]}
        triggerStyle="settings"
        open
        selection={{
          kind: catalog.selected.binding.kind,
          model: catalog.selected.model,
          reasoningEffort: "none",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Local",
          selection: "local",
          modelCatalog: catalog,
        }}
      />
    </NodexTooltipProvider>
  );
}
function renderPicker(catalog: AgentModelCatalogPresentation) {
  return renderWithMaitai(<Picker catalog={catalog} />);
}
const presentation = (
  patch: Partial<AgentModelCatalogPresentation> = {},
): AgentModelCatalogPresentation => ({
  selected,
  entries: [{ binding: selected.binding, label: "Local", model, selection: selected }],
  loading: false,
  choose: vi.fn(),
  refresh: vi.fn(),
  manage: vi.fn(),
  ...patch,
});
const click = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0, ctrlKey: false });
    fireEvent.click(element);
    await Promise.resolve();
  });
const pendingWrite = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

test("expands OpenCode models and chooses the exact paid instance, model and advertised options", async () => {
  const choose = vi.fn();
  const free = catalogModel("opencode/glm-5.3-flash-free", "GLM Flash Free");
  const work = {
    binding: { kind: "opencode", instanceConfigId: "work" },
    model: model.id,
    options: [{ id: "variant", value: "deep" }],
    modeId: "build",
  } as const;
  const view = renderPicker(
    presentation({
      choose,
      entries: [
        {
          binding: selected.binding,
          label: "Local",
          model: free,
          selection: { binding: selected.binding, model: free.id },
        },
        { binding: selected.binding, label: "Local", model, selection: selected },
        { binding: work.binding, label: "Work", model, selection: work },
      ],
    }),
  );
  await view.findByRole("option", { name: /GLM Flash Free.*Local/ });
  await view.findByRole("option", { name: /Kimi K3.*Local/ });
  expect(view.queryByRole("option", { name: /Kimi K3.*Work/ })).toBeNull();
  await click(await view.findByRole("button", { name: "Show all models" }));
  await view.findByRole("option", { name: /Kimi K3.*Work/ });
  expect(choose).not.toHaveBeenCalled();
  // Async queries manage their own act environment; resolve before entering the interaction.
  const search = await view.findByRole("combobox", { name: "Search models" });
  await act(async () => {
    fireEvent.change(search, {
      target: { value: "work" },
    });
    await Promise.resolve();
  });
  const rows = await waitFor(() => {
    const matching = within(view.getByRole("listbox")).getAllByRole("option");
    expect(matching).toHaveLength(1);
    return matching;
  });
  await click(rows[0]!);
  await waitFor(() => expect(choose).toHaveBeenCalledWith(work));
});

test("exposes boolean and native mode controls plus provider setup with a single model", async () => {
  const changeConfig = vi.fn(async () => {});
  const changeMode = vi.fn(async () => {});
  const manage = vi.fn();
  const view = renderPicker(
    presentation({
      changeConfig,
      changeMode,
      manage,
      configOptions: [
        {
          type: "boolean",
          id: "retain",
          name: "Memory",
          category: null,
          description: null,
          currentValue: true,
        },
      ],
      modes: {
        currentModeId: "build",
        availableModes: [
          { id: "build", name: "Build", description: null },
          { id: "review-native", name: "Review", description: null },
        ],
      },
    }),
  );
  expect(view.queryByRole("button", { name: /^Effort/ })).toBeNull();
  await click(await view.findByRole("button", { name: "Memory On" }));
  await click(await view.findByRole("menuitem", { name: "Off" }));
  await waitFor(() => expect(changeConfig).toHaveBeenCalledWith("retain", false));
  await click(await view.findByRole("button", { name: "Mode Build" }));
  await click(await view.findByRole("menuitem", { name: "Review" }));
  await waitFor(() => expect(changeMode).toHaveBeenCalledWith("review-native"));
  await click(await view.findByRole("button", { name: "Manage providers" }));
  expect(manage).toHaveBeenCalledOnce();
});

test("dismisses option menus before asynchronous writes and keeps them closed after settlement", async () => {
  const variantWrite = pendingWrite();
  const modeWrite = pendingWrite();
  const changeConfig = vi.fn();
  const changeMode = vi.fn();
  function DeferredPicker() {
    const [variant, setVariant] = useState("low");
    const [mode, setMode] = useState("build");
    return (
      <Picker
        catalog={presentation({
          configOptions: [
            {
              type: "select",
              id: "variant",
              name: "Variant",
              category: "thought_level",
              description: null,
              currentValue: variant,
              options: [
                { value: "low", name: "low", description: null },
                { value: "high", name: "high", description: null },
              ],
            },
          ],
          changeConfig: async (id, value) => {
            changeConfig(id, value);
            await variantWrite.promise;
            setVariant(String(value));
          },
          modes: {
            currentModeId: mode,
            availableModes: [
              { id: "build", name: "build", description: null },
              { id: "plan", name: "plan", description: null },
            ],
          },
          changeMode: async (value) => {
            changeMode(value);
            await modeWrite.promise;
            setMode(value);
          },
        })}
      />
    );
  }
  const view = renderWithMaitai(<DeferredPicker />);
  await click(await view.findByRole("button", { name: "Variant low" }));
  await click(await view.findByRole("menuitem", { name: "high" }));
  await waitFor(() => expect(changeConfig).toHaveBeenCalledWith("variant", "high"));
  await waitFor(() => expect(view.queryByRole("menuitem", { name: "high" })).toBeNull());
  expect(view.getByRole("button", { name: "Variant low" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    variantWrite.resolve();
    await variantWrite.promise;
  });
  await view.findByRole("button", { name: "Variant high" });
  await waitFor(() => expect(view.queryByRole("menuitem", { name: "high" })).toBeNull());
  await click(await view.findByRole("button", { name: "Mode build" }));
  await click(await view.findByRole("menuitem", { name: "plan" }));
  await waitFor(() => expect(changeMode).toHaveBeenCalledWith("plan"));
  await waitFor(() => expect(view.queryByRole("menuitem", { name: "plan" })).toBeNull());
  await act(async () => {
    modeWrite.resolve();
    await modeWrite.promise;
  });
  await view.findByRole("button", { name: "Mode plan" });
  await waitFor(() => expect(view.queryByRole("menuitem", { name: "plan" })).toBeNull());
});

test("starts an ACP runtime before model negotiation without offering a fabricated model", async () => {
  const binding = {
    kind: "acp",
    instanceConfigId: "local",
    agentDefinitionId: "custom-agent",
  } as const;
  const chooseRuntime = vi.fn();
  const view = renderPicker(
    presentation({
      entries: [],
      selected: { binding, model: "" },
      runtimeOptions: [{ binding, label: "Local agent" }],
      chooseRuntime,
    }),
  );
  expect(view.queryAllByRole("option")).toEqual([]);
  await click(await view.findByRole("button", { name: "Start with Local agent" }));
  expect(chooseRuntime).toHaveBeenCalledWith(binding);
});

test("keeps Codex selectable and exposes Refresh when external inventory fails", async () => {
  const binding = { kind: "codex" } as const;
  const codex = catalogModel("gpt-codex", "Codex model");
  const choice = { binding, model: codex.id };
  const refresh = vi.fn();
  const choose = vi.fn();
  const view = renderPicker(
    presentation({
      selected: choice,
      entries: [{ binding, label: "Codex", model: codex, selection: choice }],
      error: "Could not read Agent profiles",
      refresh,
      choose,
    }),
  );
  expect(await view.findByText("Could not read Agent profiles")).not.toBeNull();
  expect(within(view.getByRole("listbox")).getAllByRole("option")).toHaveLength(1);
  await click(await view.findByRole("button", { name: "Refresh models" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(choose).not.toHaveBeenCalled();
});

function MenuPicker({ catalog }: { readonly catalog: AgentModelCatalogPresentation }) {
  const [open, setOpen] = useState(true);
  return (
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[model]}
        triggerStyle="settings"
        open={open}
        onOpenChange={setOpen}
        selection={{
          kind: catalog.selected.binding.kind,
          model: catalog.selected.model,
          reasoningEffort: "none",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Local",
          selection: "local",
          modelCatalog: catalog,
        }}
      />
    </NodexTooltipProvider>
  );
}

test("returns from OpenCode setup to a fresh free-model view without changing the choice", async () => {
  const choose = vi.fn();
  const open = vi.fn<(port: { readonly showModels: () => void }) => void>();
  const work = {
    binding: { kind: "opencode", instanceConfigId: "work" },
    model: model.id,
  } as const;
  const view = renderWithMaitai(
    <MenuPicker
      catalog={presentation({
        choose,
        entries: [
          { binding: selected.binding, label: "Local", model, selection: selected },
          { binding: work.binding, label: "Work", model, selection: work },
        ],
        setups: [
          {
            kind: "opencode",
            label: "Free OpenCode models",
            hint: "Install",
            tone: "default",
            action: { kind: "open", open },
          },
        ],
      })}
    />,
  );
  await click(await view.findByRole("button", { name: "Show all models" }));
  await view.findByRole("option", { name: /Kimi K3.*Work/ });
  const search = view.getByRole("combobox", { name: "Search models" });
  await act(async () => {
    fireEvent.change(search, { target: { value: "free" } });
    await Promise.resolve();
  });
  // Searching for free models finds setup before any installed model matches.
  await view.findByText("No matching models");
  await click(view.getByRole("button", { name: "Free OpenCode models Install" }));
  await waitFor(() => expect(view.queryByRole("listbox")).toBeNull());
  await waitFor(() => expect(open).toHaveBeenCalledOnce());

  await act(async () => {
    open.mock.calls[0]![0].showModels();
    await Promise.resolve();
  });
  const reopened = await view.findByRole("combobox", { name: "Search models" });
  expect((reopened as HTMLInputElement).value).toBe("");
  expect(view.queryByText("No matching models")).toBeNull();
  expect(view.getByRole("option", { name: /Kimi K3.*Local/ }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(view.queryByRole("option", { name: /Kimi K3.*Work/ })).toBeNull();
  expect(view.getByRole("button", { name: "Show all models" })).toBeTruthy();
  expect(choose).not.toHaveBeenCalled();
});

test("routes an OpenCode executable that needs updating to provider settings", async () => {
  const manage = vi.fn();
  const view = renderWithMaitai(
    <MenuPicker
      catalog={presentation({
        manage,
        setups: [
          {
            kind: "opencode",
            label: "Free OpenCode models",
            hint: "Update",
            tone: "default",
            action: { kind: "settings" },
          },
        ],
      })}
    />,
  );
  await click(await view.findByRole("button", { name: "Free OpenCode models Update" }));
  await waitFor(() => expect(manage).toHaveBeenCalledOnce());
});

test("reads the catalog again each time it opens without forcing providers to check", async () => {
  const reload = vi.fn();
  const refresh = vi.fn();
  const catalog = presentation({ reload, refresh });
  const view = renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[model]}
        triggerStyle="composer"
        selection={{
          kind: catalog.selected.binding.kind,
          model: catalog.selected.model,
          reasoningEffort: "none",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Local",
          selection: "local",
          modelCatalog: catalog,
        }}
      />
    </NodexTooltipProvider>,
  );
  const trigger = await view.findByRole("button", { name: "Select model" });
  await click(trigger);
  expect(await view.findByRole("listbox")).not.toBeNull();
  expect(reload).toHaveBeenCalledOnce();

  await act(async () => {
    fireEvent.keyDown(within(view.getByRole("listbox")).getAllByRole("option")[0]!, {
      key: "Escape",
    });
    await Promise.resolve();
  });
  await waitFor(() => expect(view.queryByRole("listbox")).toBeNull());
  await click(trigger);
  expect(await view.findByRole("listbox")).not.toBeNull();
  expect(reload).toHaveBeenCalledTimes(2);
  expect(refresh).not.toHaveBeenCalled();
});

test("sets Claude effort on one track and turns Ultracode on at that effort", async () => {
  const opus = {
    ...catalogModel("claude-opus-5-5", "Claude Opus 5.5"),
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: "medium",
  };
  const claude = {
    binding: { kind: "claude", instanceConfigId: "claude" },
    model: opus.id,
  } as const;
  const change = vi.fn(async () => {});
  const view = renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[opus]}
        open
        selection={{
          kind: "claude",
          model: opus.id,
          reasoningEffort: "default",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Claude",
          selection: "claude",
          nativeIntelligence: {
            selected: { fast: false, ultracode: false, thinking: true },
            capabilities: { fastMode: true, ultracode: true },
            change,
          },
          modelCatalog: presentation({
            selected: claude,
            entries: [{ binding: claude.binding, label: "Claude", model: opus, selection: claude }],
          }),
        }}
      />
    </NodexTooltipProvider>,
  );
  const effort = await view.findByRole("slider", { name: "Effort" });
  expect(effort.getAttribute("aria-valuetext")).toBe("Medium");
  await act(async () => {
    fireEvent.keyDown(effort, { key: "ArrowRight" });
    await Promise.resolve();
  });
  expect(change).toHaveBeenLastCalledWith({ effort: "high", thinking: true });

  const ultracode = view.getByRole("button", { name: "Ultracode" });
  expect(ultracode.getAttribute("aria-pressed")).toBe("false");
  await click(ultracode);
  await waitFor(() => expect(change).toHaveBeenLastCalledWith({ ultracode: true }));
});

test("keeps an unavailable Ultracode visible, explains it, and never turns it on", async () => {
  const opus = {
    ...catalogModel("claude-opus-5-5", "Claude Opus 5.5"),
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "high" }],
    defaultReasoningEffort: "high",
  };
  const claude = {
    binding: { kind: "claude", instanceConfigId: "claude" },
    model: opus.id,
  } as const;
  const change = vi.fn(async () => {});
  const view = renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[opus]}
        open
        selection={{ kind: "claude", model: opus.id, reasoningEffort: "high", serviceTier: null }}
        onSelectionChange={() => {}}
        provider={{
          label: "Claude",
          selection: "claude",
          nativeIntelligence: {
            selected: { ultracode: true, thinking: true },
            capabilities: { ultracodeUnavailableReason: "Dynamic workflows are off." },
            change,
          },
          modelCatalog: presentation({
            selected: claude,
            entries: [{ binding: claude.binding, label: "Claude", model: opus, selection: claude }],
          }),
        }}
      />
    </NodexTooltipProvider>,
  );
  const ultracode = await view.findByRole("button", { name: "Ultracode" });
  expect(ultracode.getAttribute("aria-disabled")).toBe("true");
  expect(ultracode.getAttribute("aria-pressed")).toBe("false");
  await click(ultracode);
  expect(change).not.toHaveBeenCalled();
});
