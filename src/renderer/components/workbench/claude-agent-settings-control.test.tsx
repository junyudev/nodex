import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import {
  defaultClaudeInstance,
  type ClaudeAgentSettings,
} from "../../../shared/claude-agent-settings";
import { render } from "../../test/dom";
import {
  ClaudeAgentSettingsControl,
  type ClaudeAgentSettingsRuntime,
} from "./claude-agent-settings-control";

it("pastes exports, saves once, redacts saved tokens and retains them on subsequent edits", async () => {
  const update = vi.fn<ClaudeAgentSettingsRuntime["update"]>(async (input) => ({
    instances: input.instances.map((instance) => ({
      ...instance,
      environment: instance.environment.map((variable) =>
        variable.sensitive ? { name: variable.name, sensitive: true, value: null } : variable,
      ),
    })),
  }));
  const runtime: ClaudeAgentSettingsRuntime = {
    read: async () => ({ instances: [defaultClaudeInstance()] }),
    update,
  };
  const view = render(<ClaudeAgentSettingsControl open runtime={runtime} />);
  await waitFor(() =>
    expect((view.getByRole("button", { name: "Add variable" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Add variable" }));
  });
  await act(async () => {
    fireEvent.paste(view.getByLabelText("Variable name 1"), {
      clipboardData: {
        getData: () =>
          'export ANTHROPIC_BASE_URL="https://router.example/"\nexport ANTHROPIC_AUTH_TOKEN="test-only-token"\nANTHROPIC_API_KEY=""',
      },
    });
  });
  expect((view.getByLabelText("Variable value 2") as HTMLInputElement).type).toBe("password");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0].instances[0]?.environment).toEqual([
    { name: "ANTHROPIC_BASE_URL", sensitive: false, value: "https://router.example/" },
    { name: "ANTHROPIC_AUTH_TOKEN", sensitive: true, value: "test-only-token" },
    { name: "ANTHROPIC_API_KEY", sensitive: true, value: "" },
  ]);
  await waitFor(() =>
    expect((view.getByLabelText("Variable value 2") as HTMLInputElement).value).toBe(""),
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Variable value 1"), {
      target: { value: "https://updated.example" },
    });
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0].instances[0]?.environment[1]).toEqual({
    name: "ANTHROPIC_AUTH_TOKEN",
    sensitive: true,
    value: null,
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Remove variable 2" }));
  });
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
  expect(update.mock.calls[2]?.[0].instances[0]?.environment.map(({ name }) => name)).toEqual([
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
  ]);
});

it("keeps drafts on save failure and rejects invalid pasted commands without replacing rows", async () => {
  const saved: ClaudeAgentSettings = {
    instances: [
      {
        ...defaultClaudeInstance(),
        environment: [{ name: "TOKEN", sensitive: true, value: null }],
      },
    ],
  };
  const update = vi.fn<ClaudeAgentSettingsRuntime["update"]>(async () => {
    throw new Error("Secure storage unavailable");
  });
  const view = render(
    <ClaudeAgentSettingsControl open runtime={{ read: async () => saved, update }} />,
  );
  await view.findByLabelText("Variable value 1");
  await act(async () => {
    fireEvent.change(view.getByLabelText("Variable value 1"), { target: { value: "replacement" } });
  });
  await act(async () => {
    fireEvent.paste(view.getByLabelText("Variable value 1"), {
      clipboardData: { getData: () => 'export TOKEN="$(bad-command)"' },
    });
  });
  await view.findByRole("alert");
  expect((view.getByLabelText("Variable value 1") as HTMLInputElement).value).toBe("replacement");
  await act(async () => {
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await view.findByText("Secure storage unavailable");
  expect((view.getByLabelText("Variable value 1") as HTMLInputElement).value).toBe("replacement");
});
