import { afterEach, beforeEach } from "vite-plus/test";
import {
  COMMAND_KEYBINDINGS_CHANGED_CHANNEL,
  createCommandKeymapState,
} from "../../shared/command-keybindings";
import { resolveCodexRendererCommandPlatform } from "@/lib/codex-window-runtime";
import { installWindowApi } from "./browser-globals";

/** Supplies the persisted keymap boundary for browser surfaces without Electron. */
export function installCommandKeymapFixture(): void {
  let originalApi: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalApi = Object.getOwnPropertyDescriptor(window, "api");
    installWindowApi({
      invoke: async (channel) => {
        if (channel !== "codex-command-keymap-state") {
          throw new Error(`Unexpected keymap fixture request: ${channel}`);
        }
        return createCommandKeymapState({}, resolveCodexRendererCommandPlatform());
      },
      on: (channel) => {
        if (channel !== COMMAND_KEYBINDINGS_CHANGED_CHANNEL) {
          throw new Error(`Unexpected keymap fixture subscription: ${channel}`);
        }
        return () => undefined;
      },
    } satisfies Pick<NonNullable<Window["api"]>, "invoke" | "on">);
  });
  afterEach(() => {
    if (originalApi) {
      Object.defineProperty(window, "api", originalApi);
      return;
    }
    Reflect.deleteProperty(window, "api");
  });
}
