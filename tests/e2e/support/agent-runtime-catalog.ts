import { expect, type Page } from "@playwright/test";
import type { IpcApi } from "../../../src/shared/ipc-api";
import { invokeIpc } from "./editor-scenario";

/** A refresh checks Codex availability before its model inventory has finished loading. */
export const waitForCodexRuntimeCatalog = async (
  page: Page,
): Promise<IpcApi["agent-runtime:providers:read"]["result"]> => {
  await invokeIpc(page, "agent-runtime:providers:read", { refresh: true });
  let providers: IpcApi["agent-runtime:providers:read"]["result"] = [];
  await expect
    .poll(
      async () => {
        providers = await invokeIpc(page, "agent-runtime:providers:read", {});
        return providers.find((provider) => provider.instanceId === "codex")?.models.length ?? 0;
      },
      { message: "The Codex Runtime catalog should advertise a model" },
    )
    .toBeGreaterThan(0);
  return providers;
};
