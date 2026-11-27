import { createHash } from "node:crypto";
import { BrowserWindow } from "electron";
import * as Effect from "effect/Effect";
import {
  defaultVisualTheme,
  type VisualAppearance,
  type VisualCapture,
  type VisualCaptureResult,
  type VisualTheme,
} from "../../shared/visual/bridge";
import type { VisualCompilation } from "../../shared/visual/compiler";
import { VISUAL_LIMITS, type VisualRows } from "../../shared/visual/contract";
import { compileVisual } from "../../shared/visual/native";
import { prepareVisualGuest } from "./VisualGuest";

type Compiled = Extract<VisualCompilation, { ok: true }>;
const defaultWidth = 960;

function capture(compiled: Compiled, rows: VisualRows, theme: VisualTheme, hash: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const guest = yield* Effect.acquireRelease(prepareVisualGuest(), (guest) =>
        Effect.sync(guest.close),
      );
      const preferences: Electron.WebPreferences = { offscreen: true };
      guest.preferences(preferences);
      const window = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new BrowserWindow({
              show: false,
              paintWhenInitiallyHidden: true,
              width: defaultWidth,
              height: VISUAL_LIMITS.pixelsPerSide,
              useContentSize: true,
              enableLargerThanScreen: true,
              webPreferences: preferences,
            }),
        ),
        (window) =>
          Effect.sync(() => {
            if (!window.isDestroyed()) window.destroy();
          }),
      );
      guest.bind(window.webContents);
      yield* Effect.tryPromise(() => window.loadURL(guest.grant.url)).pipe(
        Effect.timeout("5 seconds"),
      );
      const reply = yield* guest.render(compiled.code, compiled.program, rows, theme);
      if (reply.status === "error") return { status: "error" as const, reply };
      const { frame } = reply;
      const png = yield* Effect.tryPromise(async () => {
        const image = await window.webContents.capturePage({
          x: 0,
          y: 0,
          width: frame.width,
          height: frame.height,
        });
        if (image.isEmpty()) throw new Error("Visual screenshot was empty");
        return image.toPNG({ scaleFactor: 1 });
      }).pipe(Effect.timeout("5 seconds"));
      return {
        status: "captured" as const,
        capture: { appearance: theme.appearance, hash, frame, png },
      };
    }),
  );
}

/** A process-local cache of derived captures. Callers resolve Page Sources before looking up a hash. */
export function createVisualService() {
  const cache = new Map<string, VisualCapture>();
  const remember = (artifact: VisualCapture) => {
    cache.set(artifact.hash, artifact);
    if (cache.size > 8) cache.delete(cache.keys().next().value!);
    return artifact;
  };

  const check = Effect.fn("Visual.check")(function* (
    source: string,
    resolve: (compiled: Compiled) => Effect.Effect<VisualRows, unknown>,
    appearances: readonly VisualAppearance[] = ["light", "dark"],
  ) {
    const compiled = compileVisual(source);
    const output: VisualCaptureResult = { diagnostics: [...compiled.diagnostics], captures: [] };
    if (!compiled.ok) return output;
    const resolved = yield* Effect.result(resolve(compiled));
    if (resolved._tag === "Failure") {
      output.diagnostics.push({
        severity: "error",
        code: "source",
        message:
          resolved.failure instanceof Error
            ? resolved.failure.message
            : "A Visual source could not be resolved",
      });
      return output;
    }
    const rows = resolved.success;
    output.resolved = { captions: compiled.program.figures.map(({ caption }) => caption), rows };
    for (const appearance of appearances) {
      const theme = defaultVisualTheme(appearance);
      const hash = createHash("sha256")
        .update(JSON.stringify([source, rows, theme]))
        .digest("hex");
      const cached = cache.get(hash);
      if (cached) {
        output.captures.push(cached);
        continue;
      }
      const attempt = yield* Effect.result(capture(compiled, rows, theme, hash));
      if (attempt._tag === "Success" && attempt.success.status === "captured") {
        output.captures.push(remember(attempt.success.capture));
        continue;
      }
      const message =
        attempt._tag === "Failure"
          ? attempt.failure instanceof Error
            ? attempt.failure.message
            : "Visual rendering failed"
          : (attempt.success.reply?.message ?? "Visual rendering failed");
      const location = attempt._tag === "Success" ? attempt.success.reply?.location : undefined;
      output.diagnostics.push({
        severity: "error",
        code: "render",
        message,
        appearance,
        span: location ? compiled.locate(location.line, location.column) : undefined,
      });
    }
    for (const { appearance, frame } of output.captures) {
      output.diagnostics.push(
        ...frame.diagnostics.map((diagnostic) => ({ ...diagnostic, appearance })),
      );
    }
    return output;
  });

  return { check };
}
