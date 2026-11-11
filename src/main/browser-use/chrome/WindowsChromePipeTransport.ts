import path from "node:path";
import * as Effect from "effect/Effect";
import type { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import type { WindowsDesktopToolsService } from "../../platform/node/WindowsDesktopTools";
import type { WindowsChromePipeTransport } from "./ChromeExtensionPipeRegistry";

export function createWindowsChromePipeTransport(options: {
  readonly callbacks: ScopedCallbackRuntime["Service"];
  readonly native: WindowsDesktopToolsService;
  readonly nativeHostPath: string;
  readonly ownsRegistration: () => Promise<boolean>;
  readonly verifyHost: () => Promise<void>;
}): WindowsChromePipeTransport {
  const { callbacks, native, nativeHostPath, ownsRegistration, verifyHost } = options;
  return {
    enumerate: async (prefix, limit) => {
      if (!(await ownsRegistration())) return [];
      return (await callbacks.runPromise(native.enumeratePipes(prefix, limit))).names;
    },
    withPeer: (endpoint, signal, use) =>
      callbacks.runPromise(
        Effect.gen(function* () {
          const { peer, stream } = yield* native.connectPipe(endpoint);
          // The native service holds the process handle for the connection lifetime.
          // Keep a listener attached even if authorization rejects before any request.
          stream.on("error", () => undefined);
          return yield* Effect.tryPromise({
            try: async () => {
              if (
                !path.win32.isAbsolute(peer.imagePath) ||
                path.win32.normalize(peer.imagePath).toLowerCase() !==
                  path.win32.normalize(nativeHostPath).toLowerCase()
              ) {
                throw new Error("Browser extension pipe belongs to a different native host");
              }
              if (!(await ownsRegistration())) {
                throw new Error("This Profile no longer owns browser control");
              }
              await verifyHost();
              signal.throwIfAborted();
              return use(stream);
            },
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          });
        }).pipe(Effect.scoped),
        { signal },
      ),
  };
}
