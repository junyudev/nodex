import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layer } from "../../host-runtime/DatabaseNotifierRuntime";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const liveForSpace = (spaceId: string | null) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const windows = yield* WindowRuntime;
      return layer({
        windowCount: windows.count,
        publish: (channel, payload) =>
          safeBroadcastToWindows(
            windows.all().filter((window) => {
              const url = window.webContents.getURL?.() ?? "";
              return (url ? new URL(url).searchParams.get("spaceId") : null) === spaceId;
            }),
            channel,
            [payload],
          ),
      });
    }),
  );
export const live = liveForSpace(null);
