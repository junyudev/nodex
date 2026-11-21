import { fireEvent } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import type { CodexExecutableProbe } from "../../../shared/codex-executable-settings";
import { render } from "../../test/dom";
import { CodexExecutableSettingsControl } from "./codex-executable-settings-control";

test.each([
  [{ status: "ready", version: "0.167.2", binaryPath: "/local/bin/codex" }, "Codex 0.167.2"],
  [
    { status: "ready", version: "0.170.1", binaryPath: "/local/bin/codex" },
    "Nodex is tested with Codex 0.167.2. Yours is 0.170.1; some features may not work.",
  ],
  [{ status: "too-old", version: "0.140.0" }, "Codex 0.140.0 · Too old: needs 0.141.0 or newer"],
  [{ status: "not-found" }, "Not found"],
  [{ status: "invalid-version" }, "Version not recognized"],
  [{ status: "probe-failed" }, "Couldn’t check the version"],
] satisfies [CodexExecutableProbe, string][])(
  "saves and reports the executable on blur (%j)",
  async (probe, message) => {
    const initial = { executable: "", activeExecutable: "", pinnedVersion: "0.167.2", probe: null };
    const view = render(
      <CodexExecutableSettingsControl
        open
        runtime={{
          read: async () => initial,
          update: async (executable) => ({ ...initial, executable, probe }),
        }}
      />,
    );
    const input = await view.findByRole("textbox", { name: "Codex executable" });
    await view.findByText(
      "Leave empty to use Nodex’s own Codex. Set a command or full path to run yours instead.",
    );
    await fireEvent.change(input, { target: { value: "/local/bin/codex" } });
    await fireEvent.blur(input);
    expect(await view.findByText(message)).toBeTruthy();
    expect(view.getByText("Applies after restarting Nodex")).toBeTruthy();
    const desktop = view.queryByText(
      "Desktop Tools stay off in Codex chats while you use your own Codex.",
    );
    expect(Boolean(desktop)).toBe(probe.status === "ready");
  },
);
