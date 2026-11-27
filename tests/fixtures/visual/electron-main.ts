import { BrowserWindow, app, protocol, webContents } from "electron";
import * as Effect from "effect/Effect";
import {
  VISUAL_SCHEME,
  VISUAL_SCHEME_PRIVILEGES,
  defaultVisualTheme,
} from "../../../src/shared/visual/bridge";
import { compileVisual } from "../../../src/shared/visual/native";
import { VisualGuestHost, visualGuestHostLive } from "../../../src/main/visual/VisualGuestHost";
import { createVisualService } from "../../../src/main/visual/VisualService";
import { noVisualPage, resolveVisualSources } from "../../../src/main/visual/VisualSources";

protocol.registerSchemesAsPrivileged([
  { scheme: VISUAL_SCHEME, privileges: VISUAL_SCHEME_PRIVILEGES },
]);
app.disableHardwareAcceleration();

const createFixture = Effect.gen(function* () {
  const host = yield* VisualGuestHost;
  const window = new BrowserWindow({
    width: 720,
    height: 520,
    show: true,
    webPreferences: { sandbox: true, webviewTag: true },
  });
  window.webContents.on("will-attach-webview", (event, preferences, params) =>
    host.willAttach(window.webContents, event, preferences, params),
  );
  window.webContents.on("did-attach-webview", (_, guest) =>
    host.didAttach(window.webContents, guest),
  );
  yield* Effect.promise(() =>
    window.loadURL(
      `data:text/html,${encodeURIComponent("<!doctype html><style>webview{display:block;width:640px;height:400px}</style><body></body>")}`,
    ),
  );
  const service = createVisualService();
  return {
    admit: () => Effect.runPromise(host.admit(window.webContents)),
    render: (grant: string, source: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const attached = host.get(window.webContents, grant);
          const compiled = compileVisual(source);
          if (!attached || !compiled.ok) throw new Error("Cannot render the fixture");
          const rows = yield* resolveVisualSources(compiled.program, noVisualPage);
          return yield* attached.render(
            compiled.code,
            compiled.program,
            rows,
            defaultVisualTheme("light"),
          );
        }),
      ),
    check: (source: string) =>
      Effect.runPromise(
        service.check(source, ({ program }) => resolveVisualSources(program, noVisualPage)),
      ),
    inspect: (id: number, probe: string) =>
      webContents.fromId(id)?.executeJavaScript(`(async () => ({
      require: typeof require,
      process: typeof process,
      api: typeof window.api,
      canReachNetwork: await fetch(${JSON.stringify(probe)}).then(() => true, () => false),
    }))()`),
  };
});

export type VisualFixture = Effect.Success<typeof createFixture>;
declare global {
  var visualFixture: VisualFixture;
}
void app.whenReady().then(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      globalThis.visualFixture = yield* createFixture;
      yield* Effect.callback<void>((resume) => {
        const quit = () => resume(Effect.void);
        app.once("before-quit", quit);
        return Effect.sync(() => app.removeListener("before-quit", quit));
      });
    }).pipe(Effect.provide(visualGuestHostLive)),
  ),
);
