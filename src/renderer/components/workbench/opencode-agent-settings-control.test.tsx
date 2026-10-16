import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { expect, it, vi } from "vite-plus/test";
import {
  defaultOpenCodeInstance,
  type OpenCodeAgentSettings,
} from "../../../shared/opencode-agent-settings";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { createOpenCodeSetupOwner } from "../../features/opencode-setup/opencode-setup-owner";
import {
  fakeSetupRuntime,
  readyExecutable,
  setupState,
} from "../../features/opencode-setup/opencode-setup.test-fixtures";
import { NodexModalHost } from "../../lib/modal-registry";
import { renderWithAppMaitai } from "../../test/app-maitai";
import {
  OpenCodeAgentSettingsControl,
  type OpenCodeAgentSettingsRuntime,
} from "./opencode-agent-settings-control";

const hostSetup = (state: OpenCodeSetupState = setupState(1)) => {
  const main = fakeSetupRuntime(state);
  return { main, owner: createOpenCodeSetupOwner(main.runtime, vi.fn()) };
};
const render = (ui: ReactElement) =>
  renderWithAppMaitai(
    <>
      {ui}
      <NodexModalHost />
    </>,
  );

const redactSettings = (
  input: Parameters<OpenCodeAgentSettingsRuntime["update"]>[0],
): OpenCodeAgentSettings => ({
  instances: input.instances.map((instance) => ({
    ...instance,
    environment: instance.environment.map((variable) =>
      variable.sensitive ? { name: variable.name, sensitive: true, value: null } : variable,
    ),
  })),
});

it("saves instance-scoped configuration and preserves saved API keys through profile changes", async () => {
  const update = vi.fn<OpenCodeAgentSettingsRuntime["update"]>(async (input) =>
    redactSettings(input),
  );
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{
        read: async () => ({ instances: [{ ...defaultOpenCodeInstance(), enabled: false }] }),
        update,
      }}
      setup={hostSetup().owner}
    />,
  );
  const enable = await view.findByRole("checkbox", { name: "Enable OpenCode" });
  await waitFor(() => expect((enable as HTMLButtonElement).disabled).toBe(false));
  await act(async () => {
    fireEvent.click(enable);
    fireEvent.change(view.getByLabelText("OpenCode profile name"), {
      target: { value: "Moonshot" },
    });
    fireEvent.change(view.getByLabelText("OpenCode profile directory"), {
      target: { value: "~/agents/moonshot" },
    });
    fireEvent.click(view.getByRole("button", { name: "Add variable" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.paste(view.getByLabelText("Variable name 1"), {
      clipboardData: { getData: () => 'MOONSHOT_API_KEY="test-only-key"' },
    });
    await Promise.resolve();
  });
  expect((view.getByLabelText("Variable value 1") as HTMLInputElement).type).toBe("password");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0].instances).toEqual([
    {
      ...defaultOpenCodeInstance(),
      displayName: "Moonshot",
      enabled: true,
      profileDirectory: "~/agents/moonshot",
      environment: [{ name: "MOONSHOT_API_KEY", value: "test-only-key", sensitive: true }],
    },
  ]);
  await waitFor(() =>
    expect((view.getByLabelText("Variable value 1") as HTMLInputElement).value).toBe(""),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add OpenCode profile" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.change(view.getByLabelText("OpenCode profile name"), {
      target: { value: "Local server" },
    });
    fireEvent.change(view.getByLabelText("OpenCode server URL"), {
      target: { value: "http://127.0.0.1:4096" },
    });
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  const instances = update.mock.calls[1]?.[0].instances ?? [];
  expect(instances).toHaveLength(2);
  expect(instances[0]?.environment).toEqual([
    { name: "MOONSHOT_API_KEY", value: null, sensitive: true },
  ]);
  expect(instances[1]).toMatchObject({
    displayName: "Local server",
    profileDirectory: null,
    serverUrl: "http://127.0.0.1:4096",
    environment: [],
  });
  expect(instances[1]?.id).not.toBe(instances[0]?.id);
});

it("retains failed edits and can remove the final instance without restoring a default", async () => {
  const update = vi
    .fn<OpenCodeAgentSettingsRuntime["update"]>()
    .mockRejectedValueOnce(new Error("Secure storage unavailable"))
    .mockImplementation(async (input) => redactSettings(input));
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{ read: async () => ({ instances: [defaultOpenCodeInstance()] }), update }}
      setup={hostSetup().owner}
    />,
  );
  await view.findByLabelText("OpenCode profile name");
  await act(async () => {
    fireEvent.change(view.getByLabelText("OpenCode profile name"), {
      target: { value: "Draft profile" },
    });
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await view.findByRole("alert");
  expect((view.getByLabelText("OpenCode profile name") as HTMLInputElement).value).toBe(
    "Draft profile",
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Remove OpenCode profile" }));
    await Promise.resolve();
  });
  expect(view.queryByLabelText("OpenCode profile name")).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await Promise.resolve();
  });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0]).toEqual({ instances: [] });
});

it("cannot overwrite instances when their configuration could not be loaded", async () => {
  const update = vi.fn<OpenCodeAgentSettingsRuntime["update"]>();
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{
        read: async () => {
          throw new Error("Settings unavailable");
        },
        update,
      }}
      setup={hostSetup().owner}
    />,
  );
  await view.findByRole("alert");
  const save = view.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await act(async () => {
    fireEvent.click(save);
    await Promise.resolve();
  });
  expect(update).not.toHaveBeenCalled();
});

/** The settings row holding the executable input, its label and its status description. */
const executableRow = async (view: ReturnType<typeof render>) =>
  (await view.findByLabelText("OpenCode executable")).parentElement!.parentElement!;

it("opens the install dialog from the saved default executable and runs only from it", async () => {
  const { main, owner } = hostSetup();
  main.runtime.install.mockResolvedValue(
    setupState(2, { installation: { phase: "running", log: { lines: [], progress: null } } }),
  );
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{
        read: async () => ({ instances: [{ ...defaultOpenCodeInstance(), enabled: false }] }),
        update: vi.fn(),
      }}
      setup={owner}
    />,
  );
  const row = await executableRow(view);
  await within(row).findByText("Not installed");
  await act(async () => {
    fireEvent.click(within(row).getByRole("button", { name: "Install" }));
    await Promise.resolve();
  });
  const dialog = await view.findByRole("dialog", { name: "Install OpenCode" });
  expect(main.runtime.install).not.toHaveBeenCalled();
  const install = await within(dialog).findByRole("button", { name: "Install" });
  await act(async () => {
    fireEvent.click(install);
    await Promise.resolve();
  });
  expect(main.runtime.install).toHaveBeenCalledOnce();
  await within(row).findByText("Installing…");
});

it("hides saved host status while an unsaved PATH changes how the profile resolves OpenCode", async () => {
  const { owner } = hostSetup();
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{ read: async () => ({ instances: [defaultOpenCodeInstance()] }), update: vi.fn() }}
      setup={owner}
    />,
  );
  await within(await executableRow(view)).findByText("Not installed");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add variable" }));
    await Promise.resolve();
  });
  await act(async () => {
    fireEvent.change(view.getByLabelText("Variable name 1"), { target: { value: "PATH" } });
    await Promise.resolve();
  });
  expect(within(await executableRow(view)).queryByText("Not installed")).toBeNull();
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Remove variable 1" }));
    await Promise.resolve();
  });
  await within(await executableRow(view)).findByText("Not installed");
});

it("leaves a saved explicit PATH in charge even while the draft removes it", async () => {
  const { main, owner } = hostSetup();
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{
        read: async () => ({
          instances: [
            {
              ...defaultOpenCodeInstance(),
              environment: [{ name: "PATH", value: "/opt/opencode/bin", sensitive: false }],
            },
          ],
        }),
        update: vi.fn(),
      }}
      setup={owner}
    />,
  );
  await executableRow(view);
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Remove variable 1" }));
    await Promise.resolve();
  });
  // Host setup is never consulted for a profile whose saved PATH owns resolution.
  await waitFor(() => expect(view.queryByLabelText("Variable name 1")).toBeNull());
  expect(main.runtime.read).not.toHaveBeenCalled();
});

it("describes a ready host and re-checks it each time settings open", async () => {
  const { main, owner } = hostSetup(setupState(1, { executable: readyExecutable("1.15.20") }));
  const runtime = {
    read: async () => ({ instances: [defaultOpenCodeInstance()] }),
    update: vi.fn(),
  };
  const view = render(<OpenCodeAgentSettingsControl open runtime={runtime} setup={owner} />);
  const row = await executableRow(view);
  await within(row).findByText(/OpenCode 1\.15\.20/);
  expect(within(row).getByText("/Users/me/.opencode/bin/opencode")).toBeTruthy();
  expect(within(row).queryByRole("button")).toBeNull();
  const reads = main.runtime.read.mock.calls.length;
  view.rerender(
    <>
      <OpenCodeAgentSettingsControl open={false} runtime={runtime} setup={owner} />
      <NodexModalHost />
    </>,
  );
  view.rerender(
    <>
      <OpenCodeAgentSettingsControl open runtime={runtime} setup={owner} />
      <NodexModalHost />
    </>,
  );
  await waitFor(() => expect(main.runtime.read.mock.calls.length).toBeGreaterThan(reads));
});

it("leaves custom executables, servers and unsaved edits to their own configuration", async () => {
  const { main, owner } = hostSetup();
  const base = defaultOpenCodeInstance();
  const view = render(
    <OpenCodeAgentSettingsControl
      open
      runtime={{
        read: async () => ({
          instances: [
            { ...base, id: "custom", displayName: "Custom", binaryPath: "/opt/bin/opencode" },
            { ...base, id: "server", displayName: "Server", serverUrl: "http://127.0.0.1:4096" },
            { ...base, id: "local", displayName: "Local" },
          ],
        }),
        update: vi.fn(),
      }}
      setup={owner}
    />,
  );
  const row = await executableRow(view);
  expect(within(row).queryByText("Not installed")).toBeNull();
  const chooseProfile = async (name: string) => {
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "OpenCode profile" }));
      await Promise.resolve();
    });
    const option = await view.findByRole("option", { name });
    await act(async () => {
      fireEvent.click(option);
      await Promise.resolve();
    });
  };
  await chooseProfile("Server");
  expect(within(await executableRow(view)).queryByText("Not installed")).toBeNull();
  await chooseProfile("Local");
  await within(await executableRow(view)).findByText("Not installed");
  await act(async () => {
    fireEvent.change(view.getByLabelText("OpenCode executable"), {
      target: { value: "/usr/local/bin/opencode" },
    });
    await Promise.resolve();
  });
  expect(within(await executableRow(view)).queryByText("Not installed")).toBeNull();
  expect(main.runtime.install).not.toHaveBeenCalled();
});
