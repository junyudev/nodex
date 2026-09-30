import { act, fireEvent, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vite-plus/test";
import type { CodexHomeSettingsSnapshot } from "../../../shared/codex-home-settings";
import { render } from "../../test/dom";
import {
  CodexHomeSettingsControl,
  type CodexHomeSettingsRuntime,
} from "./codex-home-settings-control";

const nativeHome: CodexHomeSettingsSnapshot = {
  homePath: "",
  resolvedHomePath: "/user/.codex",
  source: "default",
  activeHomePath: "/user/.codex",
  restartRequired: false,
};

it("saves a home as pending until restart and clears the override to return to the native home", async () => {
  const update = vi.fn<CodexHomeSettingsRuntime["update"]>(async ({ homePath }) => ({
    ...nativeHome,
    homePath,
    resolvedHomePath: homePath || nativeHome.resolvedHomePath,
    source: homePath ? "settings" : "default",
    restartRequired: Boolean(homePath),
  }));
  const view = render(
    <CodexHomeSettingsControl open runtime={{ read: async () => nativeHome, update }} />,
  );
  await waitFor(() =>
    expect((view.getByLabelText("Codex home") as HTMLInputElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "/user/work-codex" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await view.findByRole("status");
  expect(update).toHaveBeenCalledWith({ homePath: "/user/work-codex" });
  expect(view.getByRole("status").textContent).toBe("Restart Nodex to use /user/work-codex.");
  expect(view.getByText(nativeHome.activeHomePath)).toBeTruthy();
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "" } });
    fireEvent.click(view.getByRole("button", { name: "Save" }));
  });
  await waitFor(() => expect(view.queryByRole("status")).toBeNull());
  expect(update).toHaveBeenLastCalledWith({ homePath: "" });
});

it("retains the edited home when saving fails", async () => {
  const update = vi.fn<CodexHomeSettingsRuntime["update"]>(async () => {
    throw new Error("Codex home must be absolute or start with ~/.");
  });
  const view = render(
    <CodexHomeSettingsControl open runtime={{ read: async () => nativeHome, update }} />,
  );
  await waitFor(() =>
    expect((view.getByLabelText("Codex home") as HTMLInputElement).disabled).toBe(false),
  );
  await act(async () => {
    fireEvent.change(view.getByLabelText("Codex home"), { target: { value: "relative/path" } });
    fireEvent.keyDown(view.getByLabelText("Codex home"), { key: "Enter" });
  });
  await view.findByRole("alert");
  expect((view.getByLabelText("Codex home") as HTMLInputElement).value).toBe("relative/path");
  expect(update).toHaveBeenCalledTimes(1);
});
