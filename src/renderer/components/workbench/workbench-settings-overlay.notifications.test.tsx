import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { AppProviders } from "@/app-providers";
import { render, settleAsyncRender } from "@/test/dom";
import type {
  ThreadNotificationSettings,
  UpdateThreadNotificationSettingsInput,
} from "@/lib/types";
import { NodexSettingsSection } from "../ui/settings";
import { ThreadNotificationSettingControl } from "./workbench-settings-route-shell";

const originalApi = window.api;

afterEach(() => {
  window.api = originalApi;
});

describe("ThreadNotificationSettingControl", () => {
  test("renders turn and question preferences and persists each choice", async () => {
    let settings: ThreadNotificationSettings = {
      turnMode: "unfocused",
      questionsEnabled: true,
    };
    const updates: UpdateThreadNotificationSettingsInput[] = [];

    window.api = {
      ...(originalApi ?? {}),
      invoke: async (channel, ...args) => {
        if (channel === "settings:thread-notifications:get") return settings;
        if (channel === "settings:thread-notifications:update") {
          const nextSettings = args[0] as UpdateThreadNotificationSettingsInput;
          updates.push(nextSettings);
          settings = nextSettings;
          return settings;
        }
        return originalApi?.invoke(channel, ...args);
      },
    } as typeof window.api;

    const view = render(
      <AppProviders>
        <NodexSettingsSection title="Notifications">
          <ThreadNotificationSettingControl open />
        </NodexSettingsSection>
      </AppProviders>,
    );
    await settleAsyncRender();

    view.getByRole("region", { name: "Notifications" });
    view.getByText("Turn completion notifications");
    view.getByText("Set when agent alerts you that it's finished");
    view.getByText("Enable question notifications");
    view.getByText("Show alerts when input is needed to continue");
    expect(view.queryByText("Desktop notifications")).toBeNull();
    expect(view.queryByText("Approval requests")).toBeNull();
    expect(view.queryByText("System settings")).toBeNull();

    const questionSwitch = view.getByRole("switch", {
      name: "Enable question notifications",
    });
    expect(questionSwitch.getAttribute("aria-checked")).toBe("true");

    const trigger = view.getByRole("button", { name: "Only when unfocused" });
    await waitFor(() => {
      expect(trigger.hasAttribute("disabled")).toBe(false);
    });
    await act(async () => {
      fireEvent.mouseDown(trigger, {
        button: 0,
        ctrlKey: false,
        pointerId: 1,
        pointerType: "mouse",
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
    const alwaysOption = await view.findByRole("menuitem", { name: "Always" });
    await act(async () => {
      fireEvent.click(alwaysOption);
      await Promise.resolve();
    });
    await settleAsyncRender();

    expect(updates[0]).toEqual({
      turnMode: "always",
      questionsEnabled: true,
    });

    await act(async () => {
      fireEvent.click(questionSwitch);
      await Promise.resolve();
    });
    await settleAsyncRender();
    expect(updates[1]).toEqual({
      turnMode: "always",
      questionsEnabled: false,
    });
  });
});
