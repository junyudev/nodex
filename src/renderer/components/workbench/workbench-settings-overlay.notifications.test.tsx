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
        if (channel === "settings:notification-authorization:read") return "authorized";
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

test("requests native permission and updates its status without changing notification preferences", async () => {
  let permission = "not-determined";
  const calls: string[] = [];
  window.api = {
    ...(originalApi ?? {}),
    invoke: async (channel, ...args) => {
      calls.push(channel);
      if (channel === "settings:notification-authorization:read") return permission;
      if (channel === "settings:notification-authorization:request") {
        permission = "authorized";
        return permission;
      }
      if (channel === "settings:thread-notifications:get")
        return { turnMode: "unfocused", questionsEnabled: true };
      return originalApi?.invoke(channel, ...args);
    },
  } as typeof window.api;
  const view = render(
    <AppProviders>
      <ThreadNotificationSettingControl open />
    </AppProviders>,
  );
  const allow = await view.findByRole("button", { name: "Allow notifications" });
  await act(async () => {
    fireEvent.click(allow);
    await Promise.resolve();
  });
  await view.findByText("Allowed by macOS.");
  expect(
    calls.filter((channel) => channel === "settings:notification-authorization:request"),
  ).toHaveLength(1);
  expect(calls).not.toContain("settings:thread-notifications:update");
  expect(
    view
      .getByRole("switch", { name: "Enable question notifications" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});

test("shows denied native authorization with a settings action and preserves app preferences", async () => {
  const calls: string[] = [];
  let status = "denied";
  window.api = {
    ...(originalApi ?? {}),
    invoke: async (channel, ...args) => {
      calls.push(channel);
      if (channel === "settings:notification-authorization:read") return status;
      if (channel === "settings:notification-authorization:open-settings") return;
      if (channel === "settings:thread-notifications:get")
        return { turnMode: "always", questionsEnabled: true };
      return originalApi?.invoke(channel, ...args);
    },
  } as typeof window.api;
  const view = render(
    <AppProviders>
      <ThreadNotificationSettingControl open />
    </AppProviders>,
  );
  const settings = await view.findByRole("button", { name: "Open System Settings" });
  await act(async () => {
    fireEvent.click(settings);
    await Promise.resolve();
  });
  await waitFor(() => expect(calls).toContain("settings:notification-authorization:open-settings"));
  expect(calls).not.toContain("settings:notification-authorization:request");
  expect(calls).not.toContain("settings:thread-notifications:update");
  status = "authorized";
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  await view.findByText("Allowed by macOS.");
  expect(view.queryByRole("button", { name: "Open System Settings" })).toBeNull();
  expect(view.getByRole("button", { name: "Always" })).toBeTruthy();
  expect(
    view
      .getByRole("switch", { name: "Enable question notifications" })
      .getAttribute("aria-checked"),
  ).toBe("true");
});
