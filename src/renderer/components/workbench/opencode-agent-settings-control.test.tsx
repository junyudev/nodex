import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import {
  defaultOpenCodeInstance,
  type OpenCodeAgentSettings,
} from "../../../shared/opencode-agent-settings";
import { render } from "../../test/dom";
import {
  OpenCodeAgentSettingsControl,
  type OpenCodeAgentSettingsRuntime,
} from "./opencode-agent-settings-control";

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
      runtime={{ read: async () => ({ instances: [defaultOpenCodeInstance()] }), update }}
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
