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
  binding: { driver: "opencode", instanceId: "local" },
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
          kind: catalog.selected.binding.driver,
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
    binding: { driver: "opencode", instanceId: "work" },
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

test("dismisses option menus before asynchronous writes and keeps them closed after settlement", async () => {
  const verbosityWrite = pendingWrite();
  const modeWrite = pendingWrite();
  const changeConfig = vi.fn();
  const changeMode = vi.fn();
  function DeferredPicker() {
    const [verbosity, setVerbosity] = useState("low");
    const [mode, setMode] = useState("build");
    return (
      <Picker
        catalog={presentation({
          configOptions: [
            {
              type: "select",
              id: "verbosity",
              name: "Verbosity",
              category: null,
              description: null,
              currentValue: verbosity,
              options: [
                { value: "low", name: "low", description: null },
                { value: "high", name: "high", description: null },
              ],
            },
          ],
          changeConfig: async (id, value) => {
            changeConfig(id, value);
            await verbosityWrite.promise;
            setVerbosity(String(value));
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
  await click(await view.findByRole("button", { name: "Verbosity low" }));
  await click(await view.findByRole("menuitem", { name: "high" }));
  await waitFor(() => expect(changeConfig).toHaveBeenCalledWith("verbosity", "high"));
  await waitFor(() => expect(view.queryByRole("menuitem", { name: "high" })).toBeNull());
  expect(view.getByRole("button", { name: "Verbosity low" }).hasAttribute("disabled")).toBe(true);
  await act(async () => {
    verbosityWrite.resolve();
    await verbosityWrite.promise;
  });
  await view.findByRole("button", { name: "Verbosity high" });
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
  const binding = { driver: "acpRegistry", instanceId: "local" } as const;
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
          kind: catalog.selected.binding.driver,
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
    binding: { driver: "opencode", instanceId: "work" },
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
  await view.findByRole("option", { name: /Kimi K3.*Work/ });
  const search = view.getByRole("combobox", { name: "Search models" });
  await act(async () => {
    fireEvent.change(search, { target: { value: "free" } });
    await Promise.resolve();
  });
  // A search no model matches is answered by the setup it names, after the list instead of
  // beside it.
  await view.findByRole("button", { name: "Free OpenCode models Install" });
  expect(view.queryByRole("option")).toBeNull();
  expect(view.queryByText("No matching models")).toBeNull();
  await act(async () => {
    fireEvent.change(search, { target: { value: "nothing here" } });
    await Promise.resolve();
  });
  await view.findByText("No matching models");
  expect(view.queryByRole("button", { name: "Free OpenCode models Install" })).toBeNull();
  await act(async () => {
    fireEvent.change(search, { target: { value: "free" } });
    await Promise.resolve();
  });
  await click(await view.findByRole("button", { name: "Free OpenCode models Install" }));
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
  expect(view.getByRole("option", { name: /Kimi K3.*Work/ })).toBeTruthy();
  expect(choose).not.toHaveBeenCalled();
});

test("keeps an unavailable Ultracode visible, explains it, and never turns it on", async () => {
  const opus = {
    ...catalogModel("claude-opus-5-5", "Claude Opus 5.5"),
    supportedReasoningEfforts: [{ reasoningEffort: "high", description: "high" }],
    defaultReasoningEffort: "high",
  };
  const claude = {
    binding: { driver: "claudeAgent", instanceId: "claude" },
    model: opus.id,
  } as const;
  const change = vi.fn(async () => {});
  const view = renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[opus]}
        open
        selection={{
          kind: "claudeAgent",
          model: opus.id,
          reasoningEffort: "high",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Claude",
          selection: "claudeAgent",
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

test("shows a mode change at once without dimming, and sends a second change after the first", async () => {
  const opus = {
    ...catalogModel("claude-opus-5-5", "Claude Opus 5.5"),
    supportedReasoningEfforts: ["low", "high"].map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: "high",
  };
  const claude = {
    binding: { driver: "claudeAgent", instanceId: "claude" },
    model: opus.id,
  } as const;
  const write = pendingWrite();
  const change = vi.fn(async () => {
    await write.promise;
  });
  const view = renderWithMaitai(
    <NodexTooltipProvider delay={0}>
      <AgentIntelligenceDropdown
        models={[opus]}
        open
        selection={{
          kind: "claudeAgent",
          model: opus.id,
          reasoningEffort: "high",
          serviceTier: null,
        }}
        onSelectionChange={() => {}}
        provider={{
          label: "Claude",
          selection: "claudeAgent",
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
  const fast = await view.findByRole("button", { name: "Fast" });
  await click(fast);
  expect(fast.getAttribute("aria-pressed")).toBe("true");
  expect(fast.hasAttribute("disabled")).toBe(false);
  expect(view.getByRole("slider", { name: "Effort" }).hasAttribute("disabled")).toBe(false);
  expect(
    view.getByRole("option", { name: /Claude Opus 5\.5/u }).getAttribute("aria-disabled"),
  ).not.toBe("true");
  await click(view.getByRole("button", { name: "Ultracode" }));
  expect(view.getByRole("button", { name: "Ultracode" }).getAttribute("aria-pressed")).toBe("true");
  expect(change).toHaveBeenCalledTimes(1);
  expect(change).toHaveBeenLastCalledWith({ fast: true });
  await act(async () => {
    write.resolve();
    await write.promise;
  });
  await waitFor(() => expect(change).toHaveBeenLastCalledWith({ ultracode: true }));
});

const search = async (view: ReturnType<typeof renderPicker>, value: string) => {
  const input = await view.findByRole("combobox", { name: "Search models" });
  await act(async () => {
    fireEvent.change(input, { target: { value } });
    await Promise.resolve();
  });
};

const offModels = (patch: { readonly choose?: () => Promise<void>; readonly credit?: boolean }) => {
  const paid = catalogModel("google/gemini-3.5-flash", "Gemini 3.5 Flash");
  const sol = catalogModel("gpt-6.1-sol", "GPT-6.1 Sol");
  const nodex = { driver: "codex", instanceId: `nodex_codex_${"a".repeat(32)}` } as const;
  return {
    count: 7,
    choose: patch.choose ?? vi.fn(async () => {}),
    entries: [
      {
        binding: selected.binding,
        label: "Local",
        model: paid,
        selection: { binding: selected.binding, model: paid.id },
      },
      {
        binding: nodex,
        label: "Nodex",
        spendsCredit: true,
        model: sol,
        selection: { binding: nodex, model: sol.id },
      },
    ],
  };
};

test("choosing an off model turns it on, but credit only ever turns on in Settings", async () => {
  const choose = vi.fn(async () => {});
  const manageModels = vi.fn();
  const view = renderPicker(presentation({ manageModels, off: offModels({ choose }) }));
  await search(view, "gemini");
  await click(await view.findByRole("option", { name: /Gemini 3\.5 Flash/ }));
  await waitFor(() => expect(choose).toHaveBeenCalledOnce());
  expect(manageModels).not.toHaveBeenCalled();
  await search(view, "sol");
  await click(await view.findByRole("option", { name: /GPT-6\.1 Sol.*Nodex.*Off/ }));
  await waitFor(() => expect(manageModels).toHaveBeenCalledWith("nodex"));
  expect(choose).toHaveBeenCalledOnce();
});

test("names this chat's own model as off instead of swapping it", async () => {
  const view = renderPicker(
    presentation({
      entries: [
        {
          binding: selected.binding,
          label: "Local",
          model,
          selection: selected,
          unavailableLabel: "Off",
          unavailableReason: "Kimi K3 is off in Settings → Agents.",
        },
      ],
    }),
  );
  const row = await view.findByRole("option", { name: /Kimi K3/ });
  expect(row.textContent).toContain("Off");
  expect((row as HTMLButtonElement).disabled).toBe(true);
});
