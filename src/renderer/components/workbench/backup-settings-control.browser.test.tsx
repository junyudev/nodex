import { beforeEach } from "vite-plus/test";
import { installWindowApi } from "@/test/browser-globals";
// Verify backup, diagnostics and telemetry workflows through the compiled client pipeline.
import "./workbench-settings-overlay.backups.test";

beforeEach(() => {
  installWindowApi({
    invoke: async (channel: string) =>
      channel === "persisted-atom:sync-request" ? { revision: 0, values: {} } : null,
    on: () => () => undefined,
  });
});
