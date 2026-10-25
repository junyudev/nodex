import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { NodexModalHost } from "@/lib/modal-registry";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createAcpAgentsOwner } from "./acp-agents-owner";
import { AcpAgentsSettingsSection } from "./acp-agents-settings-section";
import { acpProviderId } from "./acp-agent-model";
import {
  authState,
  discovered,
  fakeAcpRuntime,
  localInstance,
  memoryJournal,
  ok,
  operation,
  providerSnapshot,
  readyInspection,
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

function mount(main: ReturnType<typeof fakeAcpRuntime>, anchor: string | null = null) {
  const owner = createAcpAgentsOwner({
    runtime: main.runtime,
    subscribeChanges: () => () => {},
    journal: memoryJournal(),
  });
  const view = renderWithAppMaitai(
    <NodexTooltipProvider delay={0}>
      <AcpAgentsSettingsSection
        owner={owner}
        anchor={anchor}
        disclosure={{ open: true, onOpenChange: () => {} }}
      />
      <NodexModalHost />
    </NodexTooltipProvider>,
  );
  return { owner, view };
}

describe("ACP Agents settings", () => {
  test("each instance shows its live status and turning it off saves only that change", async () => {
    const qoder = registryInstance();
    const scripted = localInstance();
    const main = fakeAcpRuntime({ instances: [qoder, scripted] });
    main.runtime.knownProviders.mockResolvedValue([
      providerSnapshot({
        instanceId: acpProviderId(qoder)!,
        models: [
          { slug: "qfmodel", name: "Qwen", isCustom: false, capabilities: null },
          { slug: "dfmodel", name: "DeepSeek", isCustom: false, capabilities: null },
        ],
        ...discovered(),
      }),
    ]);
    main.runtime.inspect.mockImplementation(async ({ instanceId }) =>
      ok(
        instanceId === qoder.id
          ? readyInspection()
          : readyInspection({ status: "missing_runner", distribution: "local" } as never),
      ),
    );
    const { view } = mount(main);
    await view.findByText("Ready");
    expect(view.getByText(/2 models/)).toBeTruthy();
    expect(view.getByText("Command not found")).toBeTruthy();
    expect(view.getByText("qoder-cli · v0.2.14 · Binary")).toBeTruthy();
    expect(view.getByText("/opt/agents/scripted --acp")).toBeTruthy();

    await press(view.getByRole("switch", { name: "Turn off Qoder" }));
    await waitFor(() => expect(main.runtime.updateSettings).toHaveBeenCalledOnce());
    const saved = main.runtime.updateSettings.mock.calls[0]![0].instances;
    expect(saved.map(({ id, enabled }) => [id, enabled])).toEqual([
      ["qoder-main", false],
      ["local-one", true],
    ]);
    await view.findByText("Off");
  });

  test("a sign-in request offers the Agent's methods, including its environment variables", async () => {
    const qoder = registryInstance();
    const main = fakeAcpRuntime({ instances: [qoder] });
    main.runtime.knownProviders.mockResolvedValue([
      providerSnapshot({
        instanceId: acpProviderId(qoder)!,
        auth: { status: "unauthenticated" },
      }),
    ]);
    main.runtime.readAuth.mockResolvedValue(
      ok(
        authState({
          methods: [
            { id: "login", name: "Qoder login", description: null, type: "terminal" },
            {
              id: "token",
              name: "Access token",
              description: null,
              type: "credentials",
              envVarNames: ["QODER_PERSONAL_ACCESS_TOKEN"],
            },
          ],
        }),
      ),
    );
    const { view } = mount(main);
    await press(await view.findByRole("button", { name: "Sign in" }));
    const terminal = await view.findByRole("button", { name: "Open Qoder login" });
    expect(main.runtime.readAuth).toHaveBeenCalledWith({ instanceId: "qoder-main" });

    await press(view.getByRole("button", { name: "Set QODER_PERSONAL_ACCESS_TOKEN" }));
    const name = await view.findByDisplayValue("QODER_PERSONAL_ACCESS_TOKEN");
    expect(name).toBeTruthy();
    await type(view.getByLabelText("Variable value 1"), "pat-123");
    await press(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(main.runtime.updateSettings).toHaveBeenCalledOnce());
    expect(main.runtime.updateSettings.mock.calls[0]![0].instances[0]!.environment).toEqual([
      { name: "QODER_PERSONAL_ACCESS_TOKEN", value: "pat-123", sensitive: true },
    ]);

    main.runtime.startAuth.mockResolvedValueOnce(
      ok(
        authState({
          phase: "waiting",
          flowId: "flow",
          interaction: { type: "terminal", id: "terminal", output: "", outputOffset: 0 },
        }),
      ),
    );
    await press(terminal);
    expect(main.runtime.startAuth).toHaveBeenCalledWith({
      instanceId: "qoder-main",
      methodId: "login",
    });
    await view.findByText("Sign in using the terminal below.");
  });

  test("only a sign-in started in this window can be cancelled from it", async () => {
    const qoder = registryInstance();
    const main = fakeAcpRuntime({ instances: [qoder] });
    main.runtime.knownProviders.mockResolvedValue([
      providerSnapshot({
        instanceId: acpProviderId(qoder)!,
        auth: { status: "unauthenticated" },
      }),
    ]);
    const methods = [
      { id: "login", name: "Qoder login", description: null, type: "terminal" as const },
    ];
    // The Runtime shows another window's flow as underway, without the flow itself.
    main.runtime.readAuth.mockResolvedValue(
      ok(
        authState({
          phase: "waiting",
          message: "Sign-in is in progress in another client.",
          methods,
        }),
      ),
    );
    const { owner, view } = mount(main);
    await press(await view.findByRole("button", { name: "Sign in" }));
    await view.findByText("Sign-in is in progress in another client.");
    expect(view.queryByRole("button", { name: "Cancel" })).toBeNull();

    // That flow ended, so this window can start its own.
    main.runtime.readAuth.mockResolvedValue(ok(authState({ methods })));
    await act(async () => {
      owner.readAuth("qoder-main");
      await Promise.resolve();
    });
    const own = authState({
      phase: "waiting",
      flowId: "flow",
      methods,
      interaction: { type: "terminal", id: "terminal", output: "", outputOffset: 0 },
    });
    main.runtime.startAuth.mockResolvedValueOnce(ok(own));
    main.runtime.readAuth.mockResolvedValue(ok(own));
    await press(await view.findByRole("button", { name: "Open Qoder login" }));
    await view.findByText("Sign in using the terminal below.");
    expect(main.runtime.cancelAuth).not.toHaveBeenCalled();

    await press(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(main.runtime.cancelAuth).toHaveBeenCalledExactlyOnceWith({
        instanceId: "qoder-main",
        flowId: "flow",
      }),
    );
    await waitFor(() => expect(view.queryByRole("button", { name: "Cancel" })).toBeNull());
  });

  test("saved changes stay pending while the Agent works and clear once applied", async () => {
    const main = fakeAcpRuntime({ instances: [localInstance()] });
    const { owner, view } = mount(main, "acp-agent-local-one");
    const first = (await view.findByLabelText("Argument 1")) as HTMLInputElement;
    // Pasting several lines over the selection makes one argument per line.
    first.setSelectionRange(0, first.value.length);
    await act(async () => {
      fireEvent.paste(first, {
        clipboardData: { getData: () => "--acp\n--model\nDeepSeek Flash" },
      });
      await Promise.resolve();
    });
    expect(
      view
        .getAllByRole("textbox", { name: /^Argument \d+$/ })
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["--acp", "--model", "DeepSeek Flash"]);
    main.deferNext(["local-one"]);
    await press(view.getByRole("button", { name: "Save" }));
    await view.findByText("Saved. Changes apply when its current work finishes.");
    expect(view.getByText(/Changes pending/)).toBeTruthy();
    expect(main.settings().instances[0]!.source).toEqual({
      kind: "local",
      executable: "/opt/agents/scripted",
      args: ["--acp", "--model", "DeepSeek Flash"],
    });

    // The Agent went idle and the Runtime took the saved settings.
    main.deferNext([]);
    await act(async () => {
      owner.checkConfiguration();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.queryByText(/Changes pending/)).toBeNull());
    expect(view.getByText("Saved")).toBeTruthy();
  });

  test("renaming keeps empty and multi-line arguments exactly as saved", async () => {
    const main = fakeAcpRuntime({
      instances: [
        localInstance({
          source: {
            kind: "local",
            executable: "/opt/agents/scripted",
            args: ["--message", "", "line one\nline two"],
          },
        }),
      ],
    });
    const { view } = mount(main, "acp-agent-local-one");
    const empty = await view.findByLabelText("Argument 2");
    expect((empty as HTMLInputElement).value).toBe("");
    expect((view.getByLabelText("Argument 3") as HTMLTextAreaElement).value).toBe(
      "line one\nline two",
    );
    expect((view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await type(view.getByLabelText("Agent name"), "Scripted work");
    await press(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(main.runtime.updateSettings).toHaveBeenCalledOnce());
    expect(main.settings().instances[0]).toMatchObject({
      displayName: "Scripted work",
      source: {
        kind: "local",
        executable: "/opt/agents/scripted",
        args: ["--message", "", "line one\nline two"],
      },
    });
  });

  test("a change that can't be saved marks the field that blocks Save", async () => {
    const main = fakeAcpRuntime({ instances: [localInstance()] });
    const { view } = mount(main, "acp-agent-local-one");
    const executable = await view.findByLabelText("Executable");
    const name = view.getByLabelText("Agent name");
    const save = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    const problemOf = (field: HTMLElement) =>
      field.getAttribute("aria-invalid") === "true"
        ? document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent
        : null;

    await type(executable, " ");
    expect(problemOf(executable)).toBe("Enter the executable to run.");
    expect(save.disabled).toBe(true);
    await type(name, "");
    // One problem at a time, starting from the top.
    expect(problemOf(name)).toBe("Enter a name.");
    expect(problemOf(executable)).toBeNull();

    await press(view.getByRole("button", { name: "Discard" }));
    expect(problemOf(name)).toBeNull();
    expect(problemOf(executable)).toBeNull();
    expect(main.runtime.updateSettings).not.toHaveBeenCalled();
  });

  test("removing the last instance of a Registry Agent can uninstall it too", async () => {
    const main = fakeAcpRuntime({ instances: [registryInstance()] });
    const { view } = mount(main, "acp-agent-qoder-main");
    const detail = await view.findByLabelText("Agent name");
    expect(detail).toBeTruthy();
    const removeButtons = view.getAllByRole("button", { name: "Remove" });
    await press(removeButtons[removeButtons.length - 1]!);
    expect(
      view.getByRole("checkbox", { name: "Also uninstall" }).getAttribute("aria-checked"),
    ).toBe("true");
    await press(
      within(view.getByText("Remove Qoder?").parentElement!).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() =>
      expect(main.runtime.uninstall).toHaveBeenCalledWith({ agentId: "qoder-cli" }),
    );
    expect(main.settings().instances).toEqual([]);
  });

  test("an install in progress shows real progress and can be cancelled", async () => {
    const main = fakeAcpRuntime({ instances: [registryInstance()] });
    main.runtime.inspect.mockResolvedValue(ok(readyInspection({ status: "unprepared" } as never)));
    main.runtime.previewInstall.mockResolvedValue(
      ok({
        agentId: "qoder-cli",
        installationId: "b".repeat(64),
        version: "0.2.14",
        distribution: "binary",
        integrity: "sha256",
        sha256: "c".repeat(64),
        packageSpec: null,
        archiveUrl: "https://example.test/qoder.tar.gz",
        installDirectory: "/profile/acp/qoder",
        receiptPath: "/profile/acp/receipt.json",
        runner: "tar",
        runnerPath: "/usr/bin/tar",
        available: true,
        reason: null,
      }),
    );
    main.runtime.install.mockImplementation(async ({ operationId }) =>
      ok(
        operation({
          operationId,
          progress: { phase: "downloading", downloadedBytes: 30, totalBytes: 120 },
        }),
      ),
    );
    const { view } = mount(main);
    await press(await view.findByRole("button", { name: "Install" }));
    await waitFor(() =>
      expect(main.runtime.install).toHaveBeenCalledWith(
        expect.objectContaining({ expectedInstallationId: "b".repeat(64) }),
      ),
    );
    const progress = await view.findByRole("progressbar", { name: "Installing Qoder" });
    expect(progress.getAttribute("aria-valuenow")).toBe("25");
    await press(view.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(main.runtime.cancelOperation).toHaveBeenCalledOnce());
    await waitFor(() => expect(view.queryByRole("progressbar")).toBeNull());
    vi.restoreAllMocks();
  });
});
