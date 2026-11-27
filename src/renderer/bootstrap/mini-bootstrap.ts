import type { MiniBootstrap } from "../../shared/app-startup";
import { initializeElectronRendererLocalCommitIngress } from "../lib/electron-renderer-transport";
import { bindRendererSpace } from "../lib/renderer-space";
import { initializeRendererSentry } from "../lib/sentry-renderer";

export async function initializeMiniRenderer(): Promise<MiniBootstrap> {
  const api = window.api;
  const bootstrap = await api?.awaitInitialization?.();
  if (!api || bootstrap?.kind !== "mini") throw new Error("Expected Mini bootstrap");
  bindRendererSpace(bootstrap.space);
  initializeElectronRendererLocalCommitIngress(api);
  await initializeRendererSentry({ settings: bootstrap.diagnostics });
  return bootstrap;
}
