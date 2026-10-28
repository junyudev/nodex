import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { DownloadItem, Event, Session, WebContents, WebContentsView } from "electron";
import type { WebContentsDestructionSubscriptions } from "./platform/electron/WebContentsDestructionSubscriptions";
import { sanitizeNativeSaveFileName } from "../shared/native-file-save";

interface NativeLinkDownloadOptions {
  readonly url: string;
  readonly destruction: Pick<WebContentsDestructionSubscriptions["Service"], "subscribe">;
  readonly source: WebContents;
  readonly isCurrent: () => boolean;
  readonly createView: (session: Session) => Pick<WebContentsView, "webContents">;
}

/** A dedicated sender keeps concurrent downloads isolated while Chromium owns bytes and Save As. */
export function startNativeLinkDownload({
  url,
  destruction,
  source,
  isCurrent,
  createView,
}: NativeLinkDownloadOptions): Effect.Effect<boolean> {
  return Effect.suspend(() => {
    let cleanup = () => {};
    return Effect.callback<boolean>((resume) => {
      if (source.isDestroyed() || !isCurrent()) {
        resume(Effect.succeed(false));
        return;
      }
      const target = new URL(url);
      target.hash = "";
      const session = source.session;
      const view = createView(session);
      let admitted = false;
      let started = false;
      const closeView = () => {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      };
      const finish = (result: boolean) => {
        if (started) return;
        started = true;
        resume(Effect.succeed(result));
      };
      const sourceDestroyed = () => finish(false);
      const willDownload = (event: Event, item: DownloadItem, contents: WebContents) => {
        if (contents?.id !== view.webContents.id) return;
        if (item.getURLChain()[0] !== target.href || source.isDestroyed() || !isCurrent()) {
          event.preventDefault();
          finish(false);
          return;
        }
        try {
          // getFilename includes Chromium's Content-Disposition and redirect handling.
          item.setSaveDialogOptions({
            defaultPath: sanitizeNativeSaveFileName(item.getFilename()),
          });
          const finished = () => queueMicrotask(closeView);
          // Completed, cancelled, and interrupted downloads all release the private view.
          item.once("done", finished);
          admitted = true;
          finish(true);
        } catch {
          event.preventDefault();
          finish(false);
        }
      };
      const releaseSource = destruction.subscribe(source, sourceDestroyed);
      session.on("will-download", willDownload);
      cleanup = () => {
        releaseSource();
        session.removeListener("will-download", willDownload);
        if (!admitted) closeView();
      };
      try {
        view.webContents.downloadURL(target.href);
      } catch {
        finish(false);
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => cleanup())),
      Effect.timeoutOption("60 seconds"),
      Effect.map(Option.getOrElse(() => false)),
    );
  });
}
