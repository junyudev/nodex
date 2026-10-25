import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { AcpAgentAddDialog } from "./acp-agent-add-dialog";
import { createAcpAgentsOwner } from "./acp-agents-owner";
import {
  fakeAcpRuntime,
  memoryJournal,
  ok,
  registryAgent,
  registryInstance,
} from "./acp-agents.test-fixtures";

const press = async (element: HTMLElement) =>
  act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });

const type = async (element: HTMLElement, value: string) =>
  act(async () => {
    fireEvent.change(element, { target: { value } });
    await Promise.resolve();
  });

const key = async (element: HTMLElement, name: string) =>
  act(async () => {
    fireEvent.keyDown(element, { key: name });
    await Promise.resolve();
  });

/** The field's own problem, as assistive technology reads it. */
const problemOf = (field: HTMLElement) =>
  field.getAttribute("aria-invalid") === "true"
    ? document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent
    : null;

const PREVIEW = {
  agentId: "qoder-cli",
  installationId: "d".repeat(64),
  version: "0.2.14",
  distribution: "npx" as const,
  integrity: "registry" as const,
  sha256: null,
  packageSpec: "@qoder-ai/qodercli@0.2.14",
  archiveUrl: null,
  installDirectory: "/profile/agent-runtime/acp/npm/qoder-cli",
  receiptPath: "/profile/agent-runtime/acp/installations/d.json",
  runner: "npm" as const,
  runnerPath: "/usr/local/bin/npm",
  available: true,
  reason: null,
};

function mount(main: ReturnType<typeof fakeAcpRuntime>) {
  const owner = createAcpAgentsOwner({
    runtime: main.runtime,
    subscribeChanges: () => () => {},
    journal: memoryJournal(),
    createId: () => "op-1",
  });
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const view = renderWithAppMaitai(
    <NodexTooltipProvider delay={0}>
      <AcpAgentAddDialog owner={owner} onAdded={onAdded} onClose={onClose} />
    </NodexTooltipProvider>,
  );
  return { view, onAdded, onClose };
}

describe("Add ACP Agent dialog", () => {
  test("Registry Agents show why they can't install and install only the reviewed build", async () => {
    const main = fakeAcpRuntime({ instances: [registryInstance({ displayName: "Qoder CLI" })] });
    main.runtime.search.mockResolvedValue(
      ok({
        agents: [
          registryAgent({
            distribution: "npx",
            integrity: "registry",
            distributions: [
              { kind: "binary", available: false, runner: null, reason: "unsupported_platform" },
              { kind: "npx", available: true, runner: "npm", reason: null },
            ],
          }),
          registryAgent({
            id: "vibe",
            name: "Vibe",
            distribution: null,
            integrity: null,
            distributions: [
              { kind: "uvx", available: false, runner: "uv", reason: "runner_unavailable" },
            ],
          }),
        ],
      }),
    );
    main.runtime.previewInstall.mockResolvedValue(ok(PREVIEW));
    const { view, onAdded, onClose } = mount(main);
    await view.findByText("Requires uv");
    expect(main.runtime.search).toHaveBeenCalledWith({ query: "" });

    await press(view.getByRole("button", { name: /Qoder CLI/ }));
    await view.findByText("@qoder-ai/qodercli@0.2.14");
    expect(view.getByText(PREVIEW.installDirectory)).toBeTruthy();
    // Another instance already uses the Agent's name.
    expect((view.getByLabelText("Name") as HTMLInputElement).value).toBe("Qoder CLI 2");
    expect(main.runtime.install).not.toHaveBeenCalled();

    await press(view.getByRole("button", { name: "Install and connect" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const added = main.settings().instances[1]!;
    expect(added).toMatchObject({
      agentDefinitionId: "qoder-cli",
      displayName: "Qoder CLI 2",
      enabled: true,
      source: { kind: "registry", agentId: "qoder-cli", distribution: "auto" },
      credentials: { kind: "inherit-host-profile" },
    });
    expect(main.runtime.install).toHaveBeenCalledWith({
      operationId: "op-1",
      agentId: "qoder-cli",
      distribution: "auto",
      expectedInstallationId: PREVIEW.installationId,
    });
    expect(onAdded).toHaveBeenCalledWith(added.id);
  });

  test("a reviewed Registry Agent without a name points back at the Name field", async () => {
    const main = fakeAcpRuntime();
    main.runtime.previewInstall.mockResolvedValue(ok(PREVIEW));
    const { view, onClose } = mount(main);
    await press(await view.findByRole("button", { name: /Qoder CLI/ }));
    await view.findByText("@qoder-ai/qodercli@0.2.14");
    const name = view.getByLabelText("Name");
    await type(name, " ");

    await press(view.getByRole("button", { name: "Install and connect" }));
    expect(problemOf(name)).toBe("Enter a name.");
    expect(document.activeElement).toBe(name);
    expect(main.runtime.updateSettings).not.toHaveBeenCalled();

    await type(name, "Qoder work");
    expect(problemOf(name)).toBeNull();
    await press(view.getByRole("button", { name: "Install and connect" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(main.settings().instances[0]?.displayName).toBe("Qoder work");
  });

  test("a chosen Registry Agent's review starts at Name, and Back returns to the same search", async () => {
    const main = fakeAcpRuntime();
    main.runtime.previewInstall.mockResolvedValue(ok(PREVIEW));
    const { view } = mount(main);
    await type(await view.findByLabelText("Search the ACP Registry"), "qoder");
    await waitFor(() => expect(main.runtime.search).toHaveBeenLastCalledWith({ query: "qoder" }));
    await press(await view.findByRole("button", { name: /Qoder CLI/ }));
    await waitFor(() => expect(document.activeElement).toBe(view.getByLabelText("Name")));

    await press(view.getByRole("button", { name: "Back to search" }));
    const search = view.getByLabelText("Search the ACP Registry") as HTMLInputElement;
    expect(search.value).toBe("qoder");
    await waitFor(() => expect(document.activeElement).toBe(search));
    expect(view.getByRole("button", { name: /Qoder CLI/ })).toBeTruthy();
    expect(main.runtime.search).toHaveBeenCalledTimes(2);
  });

  test("the source tabs follow arrow keys and each source starts at its first field", async () => {
    const main = fakeAcpRuntime();
    const { view } = mount(main);
    const search = await view.findByLabelText("Search the ACP Registry");
    await waitFor(() => expect(document.activeElement).toBe(search));
    const registry = view.getByRole("tab", { name: "ACP Registry" });
    const local = view.getByRole("tab", { name: "Local command" });
    expect(registry.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      registry.focus();
      await Promise.resolve();
    });
    await key(registry, "ArrowRight");
    expect(document.activeElement).toBe(local);
    await key(local, "ArrowRight");
    expect(document.activeElement).toBe(registry);
    await key(registry, "ArrowLeft");
    await press(local);
    expect(local.getAttribute("aria-selected")).toBe("true");
    expect(view.queryByLabelText("Search the ACP Registry")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(view.getByLabelText("Executable")));
  });

  test("a blocked local command shows each problem under its field and focuses it", async () => {
    const main = fakeAcpRuntime();
    const { view } = mount(main);
    await press(view.getByRole("tab", { name: "Local command" }));
    const name = view.getByLabelText("Name");
    const executable = view.getByLabelText("Executable");
    // Problems wait for the first submit.
    expect(problemOf(executable)).toBeNull();
    expect(view.queryByRole("alert")).toBeNull();

    await press(view.getByRole("button", { name: "Add and connect" }));
    expect(problemOf(executable)).toBe("Enter the executable to run.");
    expect(document.activeElement).toBe(executable);

    await type(executable, "qoder");
    await type(name, "");
    // After a submit, the problem follows the draft.
    expect(problemOf(executable)).toBeNull();
    expect(problemOf(name)).toBe("Enter a name.");
    await press(view.getByRole("button", { name: "Add and connect" }));
    expect(document.activeElement).toBe(name);

    await type(name, "Qoder");
    await type(view.getByLabelText("Registry ID"), "Qoder CLI");
    await press(view.getByRole("button", { name: "Add and connect" }));
    const identity = view.getByLabelText("Registry ID");
    expect(problemOf(identity)).toMatch(/^A Registry ID uses lowercase letters/);
    expect(document.activeElement).toBe(identity);
    expect(main.runtime.updateSettings).not.toHaveBeenCalled();
  });

  test("an argument too long to pass is the one Add points at", async () => {
    const main = fakeAcpRuntime();
    const { view } = mount(main);
    await press(view.getByRole("tab", { name: "Local command" }));
    await type(view.getByLabelText("Executable"), "qoder");
    await press(view.getByRole("button", { name: "Add argument" }));
    await type(view.getByLabelText("Argument 1"), "--acp");
    await press(view.getByRole("button", { name: "Add argument" }));
    await type(view.getByLabelText("Argument 2"), "a".repeat(32769));

    await press(view.getByRole("button", { name: "Add and connect" }));
    const long = view.getByLabelText("Argument 2");
    expect(problemOf(long)).toBe("Argument 2 is longer than the 32,768-character limit.");
    expect(document.activeElement).toBe(long);
    expect(problemOf(view.getByLabelText("Argument 1"))).toBeNull();
    expect(main.runtime.updateSettings).not.toHaveBeenCalled();

    await type(long, "--model");
    expect(problemOf(view.getByLabelText("Argument 2"))).toBeNull();
  });

  test("a local command keeps each argument exactly and connects after saving", async () => {
    const main = fakeAcpRuntime();
    const { view, onClose } = mount(main);
    await press(view.getByRole("tab", { name: "Local command" }));
    await type(view.getByLabelText("Executable"), "bin/qoder");
    await press(view.getByRole("button", { name: "Add and connect" }));
    await view.findByText("Use an absolute path or a command on PATH.");
    expect(main.runtime.updateSettings).not.toHaveBeenCalled();

    await type(view.getByLabelText("Executable"), "qoder");
    await press(view.getByRole("button", { name: "Add argument" }));
    await type(view.getByLabelText("Argument 1"), "--acp");
    // Enter starts the next argument instead of submitting.
    await act(async () => {
      fireEvent.keyDown(view.getByLabelText("Argument 1"), { key: "Enter" });
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    await type(view.getByLabelText("Argument 2"), "--model");
    await press(view.getByRole("button", { name: "Add argument" }));
    await type(view.getByLabelText("Argument 3"), "dfmodel");
    await press(view.getByRole("button", { name: "Add and connect" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const added = main.settings().instances[0]!;
    expect(added.source).toEqual({
      kind: "local",
      executable: "qoder",
      args: ["--acp", "--model", "dfmodel"],
    });
    expect(added.agentDefinitionId).toBe(`local-${added.id}`);
    expect(main.runtime.connect).toHaveBeenCalledWith({
      instanceId: added.id,
      operationId: "op-1",
    });
  });

  test("a rejected save keeps the dialog open with Main's reason", async () => {
    const main = fakeAcpRuntime();
    main.runtime.updateSettings.mockRejectedValueOnce(new Error("Too many Agent instances."));
    const { view, onClose } = mount(main);
    await press(view.getByRole("tab", { name: "Local command" }));
    await type(view.getByLabelText("Executable"), "/opt/agent");
    await press(view.getByRole("button", { name: "Add and connect" }));
    await view.findByText("Too many Agent instances.");
    expect(onClose).not.toHaveBeenCalled();
    expect(main.runtime.connect).not.toHaveBeenCalled();
  });
});
