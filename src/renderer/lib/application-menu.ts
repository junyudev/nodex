import type { ApplicationMenuSnapshot, WindowAppearanceInput } from "../../shared/application-menu";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

const invokeMenuCommand = defineRendererCommand({
  key: "application_menu.invoke",
  channel: "application-menu:invoke",
  authority: "main",
  owner: "ApplicationMenu",
  protocol: { kind: "returned_value" },
});
const syncAppearanceCommand = defineRendererCommand({
  key: "window.appearance.sync",
  channel: "window:appearance:sync",
  authority: "main",
  owner: "WindowAppearance",
  protocol: { kind: "returned_value" },
});

export interface ApplicationMenuAdapter {
  readonly read: () => Promise<ApplicationMenuSnapshot>;
  readonly invoke: (id: string) => Promise<boolean>;
}
export const applicationMenu: ApplicationMenuAdapter = {
  read: () => invokeRendererQuery("application-menu:snapshot"),
  invoke: (id) => invokePlainCommand(invokeMenuCommand, id),
};

export const synchronizeWindowAppearance = (input: WindowAppearanceInput) =>
  invokePlainCommand(syncAppearanceCommand, input);
export const readWindowFullscreen = () => invokeRendererQuery("electron-window:fullscreen:get");
export const subscribeWindowFullscreen = (listener: (fullscreen: boolean) => void) =>
  window.api?.on("electron-window:fullscreen-changed", (state) =>
    listener(
      typeof state === "object" &&
        state !== null &&
        "fullscreen" in state &&
        state.fullscreen === true,
    ),
  ) ?? (() => {});
