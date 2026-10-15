import { fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { render, settleAsyncRender } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import { useThreadNotificationSettings } from "./use-thread-notification-settings";
import { useWindowRestoreSettings } from "./use-window-restore-settings";

let threadMode = "unfocused";

function WindowRestoreHarness() {
  const { settings, isLoading, updateSettings } = useWindowRestoreSettings();
  return (
    <button
      type="button"
      data-testid="window-restore"
      onClick={() => {
        void updateSettings({ policy: "none" });
      }}
    >
      {settings.policy}:{isLoading ? "loading" : "ready"}
    </button>
  );
}

function ThreadNotificationsHarness() {
  const { settings, reloadSettings } = useThreadNotificationSettings();
  return (
    <button
      type="button"
      data-testid="thread-notifications"
      onClick={() => {
        void reloadSettings();
      }}
    >
      {settings.turnMode}
    </button>
  );
}

describe("settings query hooks", () => {
  beforeEach(() => {
    threadMode = "unfocused";
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel === "settings:window-restore:get") {
          throw new Error("settings unavailable");
        }
        if (channel === "settings:window-restore:update") return args[0];
        if (channel === "settings:thread-notifications:get") {
          return {
            turnMode: threadMode,
            questionsEnabled: true,
          };
        }
        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: () => () => {},
    });
  });

  test("uses window restore defaults after read failure and updates cache after mutation", async () => {
    const view = render(
      <TestQueryProvider>
        <WindowRestoreHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("window-restore").textContent).toBe("all:ready");
    });

    fireEvent.click(view.getByRole("button"));
    await settleAsyncRender();

    await waitFor(() => {
      expect(view.getByTestId("window-restore").textContent).toBe("none:ready");
    });
  });

  test("reloadSettings refetches thread notification settings", async () => {
    const view = render(
      <TestQueryProvider>
        <ThreadNotificationsHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("thread-notifications").textContent).toBe("unfocused");
    });

    threadMode = "always";
    fireEvent.click(view.getByRole("button"));
    await settleAsyncRender();

    await waitFor(() => {
      expect(view.getByTestId("thread-notifications").textContent).toBe("always");
    });
  });
});
