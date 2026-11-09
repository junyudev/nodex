import * as Effect from "effect/Effect";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { DesktopNotificationRuntime } from "./DesktopNotificationRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
  Effect.gen(function* () {
      Effect.provideService(ApplicationSettings, {
      } as never),
      Effect.provideService(CodexRendererPresentationRegistry, {
        hasForegroundClient: () => false,
      } as never),
      Effect.provideService(WindowRuntime, {
        getLastFocused: () => ({
          isDestroyed: () => false,
          isMinimized: () => false,
          webContents: { id: 1 },
        }),
      } as never),
      Effect.provideService(DesktopNotificationRuntime, {
          shown.push(payload);
        },
      } as never),
      Effect.provideService(RendererClientRuntime, {
        getClientIdForWebContentsId: () => "client",
          return true;
        },
      } as never),
    );
    assert.lengthOf(shown, 1);
  }),
);
