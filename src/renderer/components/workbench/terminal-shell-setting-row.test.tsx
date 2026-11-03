import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type {
  TerminalShellSettings,
  WindowsTerminalShell,
} from "../../../shared/terminal-shell-settings";
import { installWindowApi } from "@/test/browser-globals";
import { openNodexMenu } from "@/test/dom";
import { resetTerminalShellSettingsOwnersForTests } from "@/lib/terminal-shell-settings";
import { TerminalShellSettingRow } from "./terminal-shell-setting-row";

let saved: TerminalShellSettings;
let shells: readonly WindowsTerminalShell[];
let rejectSave: boolean;
const clients: QueryClient[] = [];
const listeners = new Set<(settings: TerminalShellSettings) => void>();
const invoke = vi.fn(async (channel: string, input?: TerminalShellSettings) => {
  if (channel === "terminal-shells:list") return shells;
  if (channel === "settings:terminal-shell:get") return saved;
  if (channel !== "settings:terminal-shell:update" || !input) throw new Error(channel);
  if (rejectSave) throw new Error("Read-only settings");
  saved = input;
  for (const listener of listeners) listener(saved);
  return saved;
});
beforeEach(() => {
  saved = { windowsShell: "automatic" };
  shells = ["pwsh", "powershell", "cmd", "git-bash"];
  rejectSave = false;
  invoke.mockClear();
  resetTerminalShellSettingsOwnersForTests();
  document.documentElement.dataset.codexOs = "win32";
  installWindowApi({
    invoke,
    on: (channel: string, callback: (settings: TerminalShellSettings) => void) => {
      if (channel !== "terminal-shell-settings-changed") return () => {};
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  });
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  delete document.documentElement.dataset.codexOs;
  expect(listeners.size).toBe(0);
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <TerminalShellSettingRow />
    </QueryClientProvider>,
  );
}
async function ready(name = "Automatic") {
  const trigger = await screen.findByRole("button", { name: `Terminal shell: ${name}` });
  await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
  return trigger;
}

test("offers Automatic first and saves a discovered shell", async () => {
  shells = ["powershell", "cmd", "git-bash"];
  mount();
  await openNodexMenu(await ready());
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Automatic",
    "Windows PowerShell",
    "Command Prompt",
    "Git Bash",
  ]);
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Git Bash" }));
    await Promise.resolve();
  });
  await ready("Git Bash");
  expect(saved).toEqual({ windowsShell: "git-bash" });
  expect(invoke).toHaveBeenCalledWith("settings:terminal-shell:update", {
    windowsShell: "git-bash",
  });
});

test("keeps an uninstalled saved choice visible and disabled until Automatic is selected", async () => {
  saved = { windowsShell: "git-bash" };
  shells = ["pwsh", "cmd"];
  mount();
  await openNodexMenu(await ready("Git Bash (unavailable)"));
  expect(
    screen.getByRole("menuitem", { name: "Git Bash (unavailable)" }).getAttribute("aria-disabled"),
  ).toBe("true");
  expect(invoke).not.toHaveBeenCalledWith("settings:terminal-shell:update", expect.anything());
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Automatic" }));
    await Promise.resolve();
  });
  await ready();
  expect(saved).toEqual({ windowsShell: "automatic" });
});

test("rolls back a failed save and keeps the choice actionable", async () => {
  rejectSave = true;
  mount();
  await openNodexMenu(await ready());
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Git Bash" }));
    await Promise.resolve();
  });
  await ready();
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save terminal shell.");
  expect(saved).toEqual({ windowsShell: "automatic" });
});

test.each(["darwin", "linux"])("does not read Windows shell settings on %s", (platform) => {
  document.documentElement.dataset.codexOs = platform;
  mount();
  expect(screen.queryByRole("button")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
