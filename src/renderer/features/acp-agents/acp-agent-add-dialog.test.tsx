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
