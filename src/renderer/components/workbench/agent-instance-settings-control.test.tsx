import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  defaultClaudeInstance,
  type ClaudeAgentInstanceConfig,
  type ClaudeAgentSettings,
} from "../../../shared/claude-agent-settings";
import { render, settleAsyncRender } from "../../test/dom";
import { agentProfilesSummary } from "./agent-instance-settings-control";
import {
  change,
  click,
  deferred,
  expandProfile,
  openSection,
} from "./agent-instance-settings.test-fixtures";
import {
  ClaudeAgentSettingsControl,
  type ClaudeAgentSettingsRuntime,
} from "./claude-agent-settings-control";

const profile = (patch: Partial<ClaudeAgentInstanceConfig> = {}): ClaudeAgentInstanceConfig => ({
  ...defaultClaudeInstance(),
  ...patch,
});

/** Main's answer to a write: the profiles as given, without secret values. */
const stored = (
  input: Parameters<ClaudeAgentSettingsRuntime["update"]>[0],
): ClaudeAgentSettings => ({
  instances: input.instances.map((instance) => ({
    ...instance,
    environment: instance.environment.map((variable) => ({
      ...variable,
      value: variable.sensitive ? null : variable.value,
    })),
  })) as ClaudeAgentInstanceConfig[],
});

const field = (view: ReturnType<typeof render>, name: string) =>
  view.getByLabelText(name) as HTMLInputElement;
const saveButton = (view: ReturnType<typeof render>) =>
  view.getByRole("button", { name: /^Sav(e|ing…)$/ }) as HTMLButtonElement;

describe("Agent profile settings", () => {
  it("a switch saves only the on/off state and leaves an open draft as it was", async () => {
    const update = vi.fn<ClaudeAgentSettingsRuntime["update"]>(async (input) => stored(input));
    update.mockRejectedValueOnce(new Error("Disk full"));
    const view = render(
      <ClaudeAgentSettingsControl
        open
        disclosure={openSection}
        runtime={{ read: async () => ({ instances: [profile()] }), update }}
      />,
    );
    await expandProfile(view, "Claude Code");
    await change(field(view, "Claude Code profile name"), "Work");

    await click(view.getByRole("switch", { name: "Turn off Work" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]![0].instances).toMatchObject([
      { displayName: "Claude Code", enabled: false },
    ]);
    // The failed write leaves the profile on, as Main still has it, and the draft untouched.
    await waitFor(() =>
      expect(view.getByRole("switch", { name: "Turn off Work" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    expect(field(view, "Claude Code profile name").value).toBe("Work");

    await click(view.getByRole("switch", { name: "Turn off Work" }));
    await waitFor(() =>
      expect(view.getByRole("switch", { name: "Turn on Work" }).getAttribute("aria-checked")).toBe(
        "false",
      ),
    );
    expect(field(view, "Claude Code profile name").value).toBe("Work");

    await click(saveButton(view));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
    expect(update.mock.calls[2]![0].instances).toMatchObject([
      { displayName: "Work", enabled: false },
    ]);
  });

  it("a reread waits for a save in flight and keeps the profile locked until it lands", async () => {
    let main: ClaudeAgentSettings = { instances: [profile()] };
    const reads: ReturnType<typeof deferred<ClaudeAgentSettings>>[] = [];
    const read = vi.fn(() => {
      const next = deferred<ClaudeAgentSettings>();
      reads.push(next);
      return next.promise;
    });
    const write = deferred<void>();
    const update = vi.fn<ClaudeAgentSettingsRuntime["update"]>(async (input) => {
      await write.promise;
      main = stored(input);
      return main;
    });
    const runtime = { read, update };
    const view = render(
      <ClaudeAgentSettingsControl open disclosure={openSection} runtime={runtime} />,
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
      <ClaudeAgentSettingsControl open={false} disclosure={openSection} runtime={runtime} />,
    );
    view.rerender(<ClaudeAgentSettingsControl open disclosure={openSection} runtime={runtime} />);
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
    const reads: ReturnType<typeof deferred<ClaudeAgentSettings>>[] = [];
    const read = vi.fn(() => {
      const next = deferred<ClaudeAgentSettings>();
      reads.push(next);
      return next.promise;
    });
    const runtime = { read, update: vi.fn<ClaudeAgentSettingsRuntime["update"]>() };
    const view = render(
      <ClaudeAgentSettingsControl open disclosure={openSection} runtime={runtime} />,
    );
    view.rerender(
      <ClaudeAgentSettingsControl open={false} disclosure={openSection} runtime={runtime} />,
    );
    view.rerender(<ClaudeAgentSettingsControl open disclosure={openSection} runtime={runtime} />);

    await waitFor(() => expect(read).toHaveBeenCalledOnce());
    reads[0]!.resolve({ instances: [profile({ displayName: "Before" })] });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(view.queryByText("Before")).toBeNull();
    reads[1]!.resolve({ instances: [profile({ displayName: "After" })] });
    await view.findByText("After");
    expect(view.queryByText("Before")).toBeNull();
  });

  it("a different runtime starts from its own profiles and never writes the previous ones", async () => {
    const previous = {
      read: async () => ({ instances: [profile({ displayName: "Personal" })] }),
      update: vi.fn<ClaudeAgentSettingsRuntime["update"]>(),
    };
    const view = render(
      <ClaudeAgentSettingsControl open disclosure={openSection} runtime={previous} />,
    );
    await expandProfile(view, "Personal");
    await change(field(view, "Claude Code profile name"), "Personal draft");

    const firstRead = deferred<ClaudeAgentSettings>();
    const next = {
      read: () => firstRead.promise,
      update: vi.fn<ClaudeAgentSettingsRuntime["update"]>(async (input) => stored(input)),
    };
    view.rerender(<ClaudeAgentSettingsControl open disclosure={openSection} runtime={next} />);
    expect(view.getByRole("status").textContent).toBe("Loading profiles…");
    expect(view.queryByText(/^Personal/)).toBeNull();

    firstRead.resolve({ instances: [profile({ id: "work", displayName: "Work" })] });
    await expandProfile(view, "Work");
    await change(field(view, "Claude Code profile name"), "Work 2");
    await click(saveButton(view));
    await waitFor(() => expect(next.update).toHaveBeenCalledOnce());
    expect(
      next.update.mock.calls[0]![0].instances.map(({ id, displayName }) => [id, displayName]),
    ).toEqual([["work", "Work 2"]]);
    expect(previous.update).not.toHaveBeenCalled();
  });

  it("a new profile stays a draft until saved and takes the next free name", async () => {
    const update = vi.fn<ClaudeAgentSettingsRuntime["update"]>(async (input) => stored(input));
    const view = render(
      <ClaudeAgentSettingsControl
        open
        disclosure={openSection}
        runtime={{ read: async () => ({ instances: [] }), update }}
      />,
    );
    await click(await view.findByRole("button", { name: "Add profile" }));
    expect(field(view, "Claude Code profile name").value).toBe("Claude Code");
    expect(view.getByText("Not saved yet")).toBeTruthy();
    await click(saveButton(view));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());

    await click(view.getByRole("button", { name: "Add profile" }));
    await waitFor(() =>
      expect(field(view, "Claude Code profile name").value).toBe("Claude Code 2"),
    );
    await click(view.getByRole("button", { name: "Remove profile" }));
    await click(view.getByRole("button", { name: "Remove" }));
    expect(update).toHaveBeenCalledOnce();
    expect(view.queryByText("Claude Code 2")).toBeNull();
  });
});

describe("agentProfilesSummary", () => {
  it("describes the saved profiles in a few words", () => {
    expect(agentProfilesSummary(null)).toBeNull();
    expect(agentProfilesSummary([])).toBe("Not set up");
    expect(agentProfilesSummary([{ enabled: true }])).toBe("On");
    expect(agentProfilesSummary([{ enabled: false }])).toBe("Off");
    expect(agentProfilesSummary([{ enabled: false }, { enabled: false }])).toBe("2 profiles · Off");
    expect(agentProfilesSummary([{ enabled: true }, { enabled: false }, { enabled: true }])).toBe(
      "2 of 3 on",
    );
  });
});
