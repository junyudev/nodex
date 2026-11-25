import { act, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import { claudeAgent } from "../../../shared/agents/claude";
import { openCodeAgent } from "../../../shared/agents/opencode";
import {
  antigravityProfile,
  claudeProfile,
  openCodeProfile,
} from "../../../shared/agents/profile.test-fixtures";
import {
  agentProfileInput,
  type AgentProfile,
  type AgentProfilesUpdate,
} from "../../../shared/agents/profiles";
import type { OpenCodeSetupState } from "../../../shared/opencode-setup";
import { createOpenCodeSetupOwner } from "../../features/opencode-setup/opencode-setup-owner";
import {
  fakeSetupRuntime,
  setupState,
} from "../../features/opencode-setup/opencode-setup.test-fixtures";
import { NodexModalHost } from "../../lib/modal-registry";
import { renderWithAppMaitai } from "../../test/app-maitai";
import { render, settleAsyncRender } from "../../test/dom";
import {
  AgentProfileSettingsSection,
  type AgentProfileSettingsRuntime,
} from "./agent-instance-settings-control";
import {
  change,
  click,
  deferred,
  expandProfile,
  openSection,
} from "./agent-instance-settings.test-fixtures";

let openCodeOwner: ReturnType<typeof createOpenCodeSetupOwner>;
vi.mock(import("../../features/opencode-setup/use-opencode-setup"), async (original) => ({
  ...(await original()),
  get openCodeSetupOwner() {
    return openCodeOwner;
  },
}));
vi.mock("../../features/agent-account/antigravity-account-row", () => ({
  AntigravityAccountRow: () => <div>Account details</div>,
}));
vi.mock("../../features/antigravity-runtime/antigravity-runtime-status", () => ({
  AntigravityRuntimeRow: () => null,
  AntigravityProfileExecutable: () => null,
}));
const hostSetup = (state: OpenCodeSetupState = setupState(1)) => {
  const main = fakeSetupRuntime(state);
  openCodeOwner = createOpenCodeSetupOwner(main.runtime, vi.fn());
  return { main };
};
beforeEach(() => {
  hostSetup();
});
const renderOpenCode = (ui: ReactElement) =>
  renderWithAppMaitai(
    <>
      {ui}
      <NodexModalHost />
    </>,
  );

type ProfileResult = { instances: AgentProfile[] };
function redact(
  { instances }: AgentProfilesUpdate,
  savedSecrets: readonly string[] = [],
): ProfileResult {
  return {
    instances: instances.map((instance) => {
      if (instance.driver === antigravityAgent.driver) {
        return {
          ...instance,
          settings: { ...instance.settings, apiKey: null },
          savedSecrets,
          environment: undefined,
        };
      }
      return {
        ...instance,
        savedSecrets,
        environment: instance.environment?.map((variable) =>
          variable.sensitive ? { name: variable.name, sensitive: true, value: null } : variable,
        ),
      };
    }),
  };
}

const field = (view: ReturnType<typeof render>, name: string) =>
  view.getByLabelText(name) as HTMLInputElement;
const saveButton = (view: ReturnType<typeof render>) =>
  view.getByRole("button", { name: /^Sav(e|ing…)$/ }) as HTMLButtonElement;

describe("Agent profile settings", () => {
  it("a reread waits for a save in flight and keeps the profile locked until it lands", async () => {
    let main: ProfileResult = { instances: [claudeProfile()] };
    const reads: ReturnType<typeof deferred<ProfileResult>>[] = [];
    const read = vi.fn(() => {
      const next = deferred<ProfileResult>();
      reads.push(next);
      return next.promise;
    });
    const write = deferred<void>();
    const update = vi.fn<AgentProfileSettingsRuntime["update"]>(async (input) => {
      await write.promise;
      main = redact(input);
      return main;
    });
    const runtime = { read, update };
    const view = render(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open
        disclosure={openSection}
        runtime={runtime}
      />,
    );
    expect(view.getByRole("status").textContent).toBe("Loading profiles…");
    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    reads[0]!.resolve(main);
    await expandProfile(view, "Claude Code");
    await change(field(view, "Claude Code profile name"), "Work");
    await click(saveButton(view));
    expect(update).toHaveBeenCalledOnce();

    // Reopening Settings during the save asks for the profiles only after it lands.
    view.rerender(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open={false}
        disclosure={openSection}
        runtime={runtime}
      />,
    );
    view.rerender(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open
        disclosure={openSection}
        runtime={runtime}
      />,
    );
    await settleAsyncRender();
    expect(read).toHaveBeenCalledOnce();
    expect(field(view, "Claude Code profile name").disabled).toBe(true);
    expect(saveButton(view).disabled).toBe(true);

    write.resolve();
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(field(view, "Claude Code profile name").disabled).toBe(true);
    expect(view.getByRole("switch", { name: "Turn off Work" }).hasAttribute("disabled")).toBe(true);

    reads[1]!.resolve(main);
    await waitFor(() => expect(field(view, "Claude Code profile name").disabled).toBe(false));
    expect(field(view, "Claude Code profile name").value).toBe("Work");
    expect(saveButton(view).disabled).toBe(true);
  });

  it("a superseded read never replaces the profiles of the latest one", async () => {
    const reads: ReturnType<typeof deferred<ProfileResult>>[] = [];
    const read = vi.fn(() => {
      const next = deferred<ProfileResult>();
      reads.push(next);
      return next.promise;
    });
    const runtime = { read, update: vi.fn<AgentProfileSettingsRuntime["update"]>() };
    const view = render(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open
        disclosure={openSection}
        runtime={runtime}
      />,
    );
    view.rerender(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open={false}
        disclosure={openSection}
        runtime={runtime}
      />,
    );
    view.rerender(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open
        disclosure={openSection}
        runtime={runtime}
      />,
    );

    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    reads[0]!.resolve({ instances: [claudeProfile({ displayName: "Before" })] });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(view.queryByText("Before")).toBeNull();
    reads[1]!.resolve({ instances: [claudeProfile({ displayName: "After" })] });
    await view.findByText("After");
    expect(view.queryByText("Before")).toBeNull();
  });

  it("a different runtime starts from its own profiles and never writes the previous ones", async () => {
    const previous = {
      read: async () => ({ instances: [claudeProfile({ displayName: "Personal" })] }),
      update: vi.fn<AgentProfileSettingsRuntime["update"]>(),
    };
    const view = render(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open
        disclosure={openSection}
        runtime={previous}
      />,
    );
    await expandProfile(view, "Personal");
    await change(field(view, "Claude Code profile name"), "Personal draft");

    const firstRead = deferred<ProfileResult>();
    const next = {
      read: () => firstRead.promise,
      update: vi.fn<AgentProfileSettingsRuntime["update"]>(async (input) => redact(input)),
    };
    view.rerender(
      <AgentProfileSettingsSection
        definition={claudeAgent}
        open
        disclosure={openSection}
        runtime={next}
      />,
    );
    expect(view.getByRole("status").textContent).toBe("Loading profiles…");
    expect(view.queryByText(/^Personal/)).toBeNull();

    firstRead.resolve({ instances: [claudeProfile({ id: "work", displayName: "Work" })] });
    await expandProfile(view, "Work");
    await change(field(view, "Claude Code profile name"), "Work 2");
    await click(saveButton(view));
    await waitFor(() => expect(next.update).toHaveBeenCalledOnce());
    expect(
      next.update.mock.calls[0]![0].instances.map(({ id, displayName }) => [id, displayName]),
    ).toEqual([["work", "Work 2"]]);
    expect(previous.update).not.toHaveBeenCalled();
  });
});
it("pastes exports, saves once, redacts saved tokens and retains them on subsequent edits", async () => {
  const update = vi.fn<AgentProfileSettingsRuntime["update"]>(async (input) => redact(input));
  const runtime: AgentProfileSettingsRuntime = {
    read: async () => ({ instances: [claudeProfile()] }),
    update,
  };
  const view = render(
    <AgentProfileSettingsSection
      definition={claudeAgent}
      open
      disclosure={openSection}
      runtime={runtime}
    />,
  );
  await expandProfile(view, "Claude Code");
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
  expect(update.mock.calls[1]?.[0].instances[0]?.environment?.[1]).toEqual({
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
  expect(update.mock.calls[2]?.[0].instances[0]?.environment?.map(({ name }) => name)).toEqual([
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
  ]);
});

it("keeps drafts on save failure and rejects invalid pasted commands without replacing rows", async () => {
  const saved: ProfileResult = {
    instances: [
      {
        ...claudeProfile(),
        environment: [{ name: "TOKEN", sensitive: true, value: null }],
      },
    ],
  };
  const update = vi.fn<AgentProfileSettingsRuntime["update"]>(async () => {
    throw new Error("Secure storage unavailable");
  });
  const view = render(
    <AgentProfileSettingsSection
      definition={claudeAgent}
      open
      disclosure={openSection}
      runtime={{ read: async () => saved, update }}
    />,
  );
  await expandProfile(view, "Claude Code");
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
it("saves a profile's configuration, then its switch, keeping saved API keys through every write", async () => {
  const update = vi.fn<AgentProfileSettingsRuntime["update"]>(async (input) => redact(input));
  const view = renderOpenCode(
    <AgentProfileSettingsSection
      definition={openCodeAgent}
      open
      disclosure={openSection}
      runtime={{
        read: async () => ({ instances: [{ ...openCodeProfile(), enabled: false }] }),
        update,
      }}
    />,
  );
  await expandProfile(view, "OpenCode");
  await waitFor(() =>
    expect((view.getByLabelText("OpenCode profile name") as HTMLInputElement).disabled).toBe(false),
  );
  await change(view.getByLabelText("OpenCode profile name"), "Moonshot");
  await change(view.getByLabelText("OpenCode profile directory"), "~/agents/moonshot");
  await click(view.getByRole("button", { name: "Add variable" }));
  await act(async () => {
    fireEvent.paste(view.getByLabelText("Variable name 1"), {
      clipboardData: { getData: () => 'MOONSHOT_API_KEY="test-only-key"' },
    });
    await Promise.resolve();
  });
  expect((view.getByLabelText("Variable value 1") as HTMLInputElement).type).toBe("password");
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0].instances).toEqual([
    {
      ...agentProfileInput(openCodeProfile()),
      displayName: "Moonshot",
      enabled: false,
      settings: { profileDirectory: "~/agents/moonshot", serverUrl: null },
      environment: [{ name: "MOONSHOT_API_KEY", value: "test-only-key", sensitive: true }],
    },
  ]);
  await waitFor(() =>
    expect((view.getByLabelText("Variable value 1") as HTMLInputElement).value).toBe(""),
  );

  await click(view.getByRole("switch", { name: "Turn on Moonshot" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0].instances).toMatchObject([
    { displayName: "Moonshot", enabled: true, environment: [{ value: null, sensitive: true }] },
  ]);

  await click(await view.findByRole("button", { name: "Add profile" }));
  expect((view.getByLabelText("OpenCode profile name") as HTMLInputElement).value).toBe("OpenCode");
  await change(view.getByLabelText("OpenCode profile name"), "Local server");
  await change(view.getByLabelText("OpenCode server URL"), "http://127.0.0.1:4096");
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
  const instances = update.mock.calls[2]?.[0].instances ?? [];
  expect(instances).toHaveLength(2);
  expect(instances[0]?.environment).toEqual([
    { name: "MOONSHOT_API_KEY", value: null, sensitive: true },
  ]);
  expect(instances[1]).toMatchObject({
    displayName: "Local server",
    settings: { profileDirectory: null, serverUrl: "http://127.0.0.1:4096" },
    environment: [],
  });
  expect(instances[1]?.id).not.toBe(instances[0]?.id);
});

/** The settings row holding the executable input, its label and its status description. */
const executableRow = async (view: ReturnType<typeof renderOpenCode>) =>
  (await view.findByLabelText("OpenCode executable")).parentElement!.parentElement!;
const openProfile = async (view: ReturnType<typeof renderOpenCode>, name = "OpenCode") => {
  await expandProfile(view, name);
  return executableRow(view);
};

it("hides saved host status while an unsaved PATH changes how the profile resolves OpenCode", async () => {
  const view = renderOpenCode(
    <AgentProfileSettingsSection
      definition={openCodeAgent}
      open
      disclosure={openSection}
      runtime={{ read: async () => ({ instances: [openCodeProfile()] }), update: vi.fn() }}
    />,
  );
  await within(await openProfile(view)).findByText("Not installed");
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
it("keeps a saved key through other edits and replaces it only when one is typed", async () => {
  const update = vi.fn<AgentProfileSettingsRuntime["update"]>(async (input) =>
    redact(input, ["apiKey"]),
  );
  const globe = antigravityProfile({
    id: "work",
    displayName: "Work",
    savedSecrets: ["apiKey"],
    settings: { authMethod: "gemini-api-key", apiKey: null, gcpProject: "", gcpLocation: "" },
  });
  const view = render(
    <AgentProfileSettingsSection
      definition={antigravityAgent}
      open
      disclosure={openSection}
      anchor="antigravity-agent-work"
      runtime={{ read: async () => ({ instances: [globe] }), update }}
    />,
  );
  await view.findByLabelText("Antigravity sign-in method");
  expect(view.getByText("Account details")).toBeTruthy();
  const key = view.getByLabelText("Antigravity API key") as HTMLInputElement;
  expect(key.placeholder).toBe("Saved");
  // A key profile reads no Google Cloud project.
  expect(view.queryByLabelText("Antigravity Google Cloud project")).toBeNull();

  await change(view.getByLabelText("Antigravity profile name"), "Billing");
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
  expect(update.mock.calls[0]?.[0].instances[0]).toMatchObject({
    displayName: "Billing",
    settings: { apiKey: null },
  });

  await change(view.getByLabelText("Antigravity API key"), "new-key");
  await click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]?.[0].instances[0]?.settings).toMatchObject({ apiKey: "new-key" });
});
