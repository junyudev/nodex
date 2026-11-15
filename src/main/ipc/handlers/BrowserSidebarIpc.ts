import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { IpcMainInvokeEvent } from "electron";
import type { IpcEvents } from "../../../shared/ipc-api";
import type {
  BrowserBrowsingDataKind,
  BrowserSidebarCommand,
  BrowserSidebarCommandResult,
  BrowserSidebarWebviewDestroyed,
  BrowserSidebarWebviewHostCreated,
} from "../../../shared/browser-sidebar";
import type { BrowserSavedAnnotation } from "../../../shared/browser-annotation";
import * as FiberSet from "effect/FiberSet";
import * as Semaphore from "effect/Semaphore";
import {
  BrowserBrowsingDataKindSchema,
  BrowserSidebarLocalServerThumbnailRequestSchema,
  parseBrowserSidebarCommand,
  parseBrowserSidebarWebviewDestroyed,
  parseBrowserSidebarWebviewHostCreated,
} from "../../../shared/browser/browser-schemas";
import {
  BrowserHistoryDeleteInputSchema,
  BrowserHistoryListInputSchema,
} from "../../../shared/browser-profile";
import { MainConfig } from "../../app/MainConfig";
import { BrowserApplication } from "../../browser-application/BrowserApplication";
import { computeBrowserAnnotationEvidenceCrop } from "../../browser/browser-annotation-evidence";
import { isBrowserLocalServerCommand } from "../../browser/browser-local-server-runtime";
import {
  filterBrowserStateForViewScope,
  filterBrowserUseStateForViewScope,
} from "../../browser/browser-event-routing";
import { BrowserPresentationRuntime } from "../../host-runtime/BrowserPresentationRuntime";
import { safeBroadcastToWindows, safeSendToWebContents } from "../../ipc-safe-send";
import { TemporaryAssets } from "../../local-store/TemporaryAssets";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { WindowSessionCatalog } from "../../window-runtime/WindowSessionCatalog";

export class BrowserSidebarIpcError extends Schema.TaggedError<BrowserSidebarIpcError>()(
  "BrowserSidebarIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const attempt = <A>(
  operation: string,
  run: () => A | PromiseLike<A>,
): Effect.Effect<A, BrowserSidebarIpcError> =>
  Effect.tryPromise({
    try: async () => await run(),
    catch: (cause) => new BrowserSidebarIpcError({ operation, cause }),
  });

const commandViewScope = (command: BrowserSidebarCommand): string | null => {
  if ("browserViewScopeId" in command) return command.browserViewScopeId;
  if ("tab" in command && "browserViewScopeId" in command.tab) {
    return command.tab.browserViewScopeId;
  }
  if ("cursor" in command && "browserViewScopeId" in command.cursor) {
    return command.cursor.browserViewScopeId;
  }
  if ("event" in command && "browserViewScopeId" in command.event) {
    return command.event.browserViewScopeId;
  }
  if ("result" in command && "browserViewScopeId" in command.result) {
    return command.result.browserViewScopeId;
  }
  return null;
};

export const live: Layer.Layer<
  never,
  never,
  | BrowserApplication
  | BrowserPresentationRuntime
  | ElectronIpc
  | ElectronWindowHost
  | MainConfig
  | TemporaryAssets
  | WindowSessionCatalog
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const presentation = yield* BrowserPresentationRuntime;
    const browser = yield* BrowserApplication;
    const { events, history, localServers, localServerThumbnail, projection } = browser;
    const config = yield* MainConfig;
    const assets = yield* TemporaryAssets;
    const ipc = yield* ElectronIpc;
    const windows = yield* ElectronWindowHost;
    const windowSessions = yield* WindowSessionCatalog;

    const trusted = (event: IpcMainInvokeEvent, capabilityName: string) =>
      attempt("authorize-renderer", () =>
        requireTrustedAppRendererSender(event, capabilityName, config.rendererUrl),
      );
    const parse = <A>(operation: string, run: () => A) => attempt(operation, run);
    const resolveViewScope = (senderId: number) =>
      windowSessions.resolveForWebContents(senderId).pipe(
        Effect.flatMap((browserViewScopeId) =>
          browserViewScopeId
            ? Effect.succeed(browserViewScopeId)
            : Effect.fail(
                new BrowserSidebarIpcError({
                  operation: "resolve-browser-view-scope",
                  cause: new Error("The requesting window has no assigned Window Session"),
                }),
              ),
        ),
      );
    const requireViewScope = (senderId: number, browserViewScopeId: string) =>
      resolveViewScope(senderId).pipe(
        Effect.flatMap((expectedScopeId) =>
          expectedScopeId === browserViewScopeId
            ? Effect.void
            : Effect.fail(
                new BrowserSidebarIpcError({
                  operation: "authorize-browser-view-scope",
                  cause: new Error("Browser view scope does not belong to the requesting window"),
                }),
              ),
        ),
      );

    const captures = yield* FiberSet.make<void>();
    const scheduledCaptures = new WeakSet<BrowserSavedAnnotation>();
    const captureLane = yield* Semaphore.make(1);
    const listAnnotations = () =>
      projection.getState().tabs.flatMap((tab) => tab.annotations ?? []);
    const captureAnnotation = (
      identity: import("../../../shared/browser-sidebar").BrowserSidebarTabIdentity,
      annotation: BrowserSavedAnnotation,
    ) =>
      Effect.gen(function* () {
        const contents = projection.getWebContents(identity);
        const snapshot = projection.getTab(identity);
        if (
          !contents ||
          !snapshot ||
          contents.isDestroyed() ||
          contents.getURL() !== annotation.pageUrl
        )
          return yield* Effect.fail(new Error("The annotation page is no longer available"));
        const token = `${annotation.id}:${annotation.createdAt}:${crypto.randomUUID()}`;
        const ready = Effect.callback<void>((resume) => {
          const listener = (...args: unknown[]) => {
            const [event, channel, payload] = args as [
              { senderFrame?: { parent: unknown } },
              string,
              { token?: unknown },
            ];
            if (
              channel !== "browser-annotation-evidence-ready" ||
              payload?.token !== token ||
              event.senderFrame?.parent
            )
              return;
            resume(Effect.void);
          };
          contents.on("ipc-message", listener);
          contents.send("browser-annotation-evidence-prepare", { token });
          return Effect.sync(() => contents.removeListener("ipc-message", listener));
        }).pipe(Effect.timeout("2 seconds"));
        return yield* Effect.gen(function* () {
          yield* ready;
          return yield* attempt("capture-browser-annotation-evidence", async () => {
            if (
              contents.isDestroyed() ||
              projection.getWebContents(identity) !== contents ||
              contents.getURL() !== annotation.pageUrl
            )
              throw new Error("The annotation page changed before capture");
            const image = await contents.capturePage();
            const crop = computeBrowserAnnotationEvidenceCrop({
              anchors: annotation.anchors,
              imageSize: image.getSize(),
              viewport: snapshot.viewport,
            });
            if (!crop) throw new Error("Browser annotation evidence is outside the page");
            let evidenceImage = image.crop(crop);
            const croppedSize = evidenceImage.getSize();
            const longestSide = Math.max(croppedSize.width, croppedSize.height);
            if (longestSide > 2_048) {
              const ratio = 2_048 / longestSide;
              evidenceImage = evidenceImage.resize({
                width: Math.max(1, Math.round(croppedSize.width * ratio)),
                height: Math.max(1, Math.round(croppedSize.height * ratio)),
                quality: "best",
              });
            }
            const saved = await assets.saveUploadedImage({
              name: `browser-annotation-${Date.now()}.png`,
              mimeType: "image/png",
              bytes: evidenceImage.toPNG(),
            });
            const finalSize = evidenceImage.getSize();
            return {
              attachmentId: saved.fileName,
              source: saved.source,
              mimeType: "image/png" as const,
              width: finalSize.width,
              height: finalSize.height,
            };
          });
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (!contents.isDestroyed())
                contents.send("browser-annotation-evidence-clear", { token });
            }),
          ),
        );
      }).pipe(
        captureLane.withPermit,
        Effect.match({
          onFailure: (error) => {
            const message = "Screenshot unavailable; your annotation is saved";
            console.warn("Browser annotation capture failed", {
              ...identity,
              annotationId: annotation.id,
              error,
            });
            projection.completeAnnotationEvidence(identity, annotation, message);
          },
          onSuccess: (evidence) =>
            projection.completeAnnotationEvidence(identity, annotation, evidence),
        }),
      );

    yield* ipc.handlePlainCommand(
      "browser-sidebar-command",
      (event, rawCommand: BrowserSidebarCommand) =>
        trusted(event, "Browser control").pipe(
          Effect.andThen(
            parse("parse-browser-command", () => parseBrowserSidebarCommand(rawCommand)),
          ),
          Effect.tap((command) => {
            const scopeId = commandViewScope(command);
            return scopeId ? requireViewScope(event.sender.id, scopeId) : Effect.void;
          }),
          Effect.flatMap((command) =>
            resolveViewScope(event.sender.id).pipe(
              Effect.flatMap(
                (
                  browserViewScopeId,
                ): Effect.Effect<BrowserSidebarCommandResult, BrowserSidebarIpcError> =>
                  isBrowserLocalServerCommand(command)
                    ? localServers
                        .applyCommand(command)
                        .pipe(
                          Effect.as({ ok: true as const } satisfies BrowserSidebarCommandResult),
                        )
                    : presentation
                        .applyCommand(command, {
                          browserViewScopeId,
                          ownerWebContentsId: event.sender.id,
                        })
                        .pipe(
                          Effect.tap((result) =>
                            command.type === "save-annotation" &&
                            result.ok &&
                            result.annotation?.evidenceState === "pending"
                              ? Effect.suspend(() => {
                                  if (scheduledCaptures.has(result.annotation!)) return Effect.void;
                                  scheduledCaptures.add(result.annotation!);
                                  return FiberSet.run(
                                    captures,
                                    captureAnnotation(command, result.annotation!),
                                  ).pipe(Effect.asVoid);
                                })
                              : Effect.void,
                          ),
                          Effect.mapError(
                            (cause) =>
                              new BrowserSidebarIpcError({
                                operation: "apply-browser-command",
                                cause,
                              }),
                          ),
                        ),
              ),
            ),
          ),
        ),
    );
    yield* ipc.handleQuery("browser-sidebar-runtime-snapshot", (event) =>
      trusted(event, "Browser runtime state").pipe(
        Effect.andThen(resolveViewScope(event.sender.id)),
        Effect.flatMap((browserViewScopeId) =>
          attempt("read-browser-runtime", () => ({
            state: filterBrowserStateForViewScope(projection.getState(), browserViewScopeId),
            annotations: listAnnotations(),
            browserUseState: filterBrowserUseStateForViewScope(
              projection.getBrowserUseState(),
              browserViewScopeId,
            ),
            presentationRequests: projection.listPendingPresentations(browserViewScopeId),
          })),
        ),
      ),
    );
    yield* ipc.handlePlainCommand(
      "browser-browsing-data-clear",
      (event, rawKind: BrowserBrowsingDataKind) =>
        trusted(event, "Browser data clearing").pipe(
          Effect.andThen(
            parse("parse-browsing-data-kind", () => BrowserBrowsingDataKindSchema.parse(rawKind)),
          ),
          Effect.flatMap((kind) =>
            presentation
              .clearBrowsingData(kind)
              .pipe(
                Effect.mapError(
                  (cause) => new BrowserSidebarIpcError({ operation: "clear-browser-data", cause }),
                ),
              ),
          ),
        ),
    );
    yield* ipc.handleControl(
      "browser-sidebar-webview-host-created",
      (event, rawEvent: BrowserSidebarWebviewHostCreated) =>
        trusted(event, "Browser webview registration").pipe(
          Effect.andThen(
            parse("parse-browser-webview-registration", () =>
              parseBrowserSidebarWebviewHostCreated(rawEvent),
            ),
          ),
          Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
          Effect.flatMap((input) =>
            browser
              .webviewHostCreated(input, event.sender.id)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new BrowserSidebarIpcError({ operation: "register-browser-webview", cause }),
                ),
              ),
          ),
        ),
    );
    yield* ipc.handleControl(
      "browser-sidebar-webview-destroyed",
      (event, rawEvent: BrowserSidebarWebviewDestroyed) =>
        trusted(event, "Browser webview teardown").pipe(
          Effect.andThen(
            parse("parse-browser-webview-teardown", () =>
              parseBrowserSidebarWebviewDestroyed(rawEvent),
            ),
          ),
          Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
          Effect.flatMap((input) =>
            browser
              .webviewDestroyed(input)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new BrowserSidebarIpcError({ operation: "release-browser-webview", cause }),
                ),
              ),
          ),
        ),
    );
    yield* ipc.handleQuery("browser-history-list", (event, rawInput: unknown) =>
      trusted(event, "Browser history").pipe(
        Effect.andThen(
          parse("parse-browser-history-query", () =>
            rawInput === undefined ? {} : BrowserHistoryListInputSchema.parse(rawInput),
          ),
        ),
        Effect.flatMap((input) => history.list(input)),
      ),
    );
    yield* ipc.handlePlainCommand("browser-history-delete", (event, historyId: unknown) =>
      trusted(event, "Browser history removal").pipe(
        Effect.andThen(
          parse("parse-browser-history-removal", () =>
            BrowserHistoryDeleteInputSchema.parse({ id: historyId }),
          ),
        ),
        Effect.flatMap(({ id }) =>
          history
            .delete(id)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BrowserSidebarIpcError({ operation: "remove-browser-history", cause }),
              ),
            ),
        ),
        Effect.as({ ok: true as const }),
      ),
    );
    yield* ipc.handleQuery("browser-local-server-thumbnail", (event, rawInput: unknown) =>
      trusted(event, "Local server preview").pipe(
        Effect.andThen(
          parse("parse-local-server-thumbnail", () =>
            BrowserSidebarLocalServerThumbnailRequestSchema.parse(rawInput),
          ),
        ),
        Effect.tap((input) => requireViewScope(event.sender.id, input.browserViewScopeId)),
        Effect.flatMap((input) => {
          const admission = projection.admitLocalServerThumbnail(input);
          if (admission._tag === "Denied") return Effect.succeed(admission.result);
          return localServers.isDiscovered(input.projectId, admission.url).pipe(
            Effect.flatMap((discovered) =>
              discovered
                ? localServerThumbnail.get(admission.url)
                : Effect.succeed({
                    status: "unavailable" as const,
                    message: "Local server preview was not discovered for this project",
                  }),
            ),
          );
        }),
      ),
    );

    const sendToScope = (channel: keyof IpcEvents, browserViewScopeId: string, payload: unknown) =>
      windows.all.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            all,
            (window) =>
              windowSessions
                .resolveForWebContents(window.webContents.id)
                .pipe(
                  Effect.tap((scopeId) =>
                    scopeId === browserViewScopeId
                      ? Effect.sync(() =>
                          safeSendToWebContents(window.webContents, channel, [payload]),
                        )
                      : Effect.void,
                  ),
                ),
            { discard: true },
          ),
        ),
      );
    const sendFilteredState = (snapshot: ReturnType<typeof projection.getState>) =>
      windows.all.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            all,
            (window) =>
              windowSessions
                .resolveForWebContents(window.webContents.id)
                .pipe(
                  Effect.tap((scopeId) =>
                    scopeId
                      ? Effect.sync(() =>
                          safeSendToWebContents(window.webContents, "browser-sidebar-state", [
                            filterBrowserStateForViewScope(snapshot, scopeId),
                          ]),
                        )
                      : Effect.void,
                  ),
                ),
            { discard: true },
          ),
        ),
      );
    const sendFilteredBrowserUseState = (
      snapshot: ReturnType<typeof projection.getBrowserUseState>,
    ) =>
      windows.all.pipe(
        Effect.flatMap((all) =>
          Effect.forEach(
            all,
            (window) =>
              windowSessions
                .resolveForWebContents(window.webContents.id)
                .pipe(
                  Effect.tap((scopeId) =>
                    scopeId
                      ? Effect.sync(() =>
                          safeSendToWebContents(
                            window.webContents,
                            "browser-sidebar-browser-use-state",
                            [filterBrowserUseStateForViewScope(snapshot, scopeId)],
                          ),
                        )
                      : Effect.void,
                  ),
                ),
            { discard: true },
          ),
        ),
      );

    yield* localServers.updates.pipe(
      Stream.runForEach((snapshot) =>
        windows.all.pipe(
          Effect.tap((all) =>
            Effect.sync(() =>
              safeBroadcastToWindows(all, "browser-sidebar-local-servers", [snapshot]),
            ),
          ),
          Effect.asVoid,
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* events.events.pipe(
      Stream.runForEach((event) => {
        if (event.kind === "state")
          return sendFilteredState(event.value).pipe(
            Effect.andThen(
              windows.all.pipe(
                Effect.tap((all) =>
                  Effect.sync(() =>
                    safeBroadcastToWindows(all, "browser-annotations", [listAnnotations()]),
                  ),
                ),
              ),
            ),
          );
        if (event.kind === "browserUseState") return sendFilteredBrowserUseState(event.value);
        if (event.kind === "browserUseViewport") {
          return sendToScope(
            "browser-sidebar-browser-use-viewport",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "browserUseCaptureSurface") {
          return sendToScope(
            "browser-sidebar-browser-use-capture-surface",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "browserUseCursor") {
          return sendToScope(
            "browser-sidebar-browser-use-cursor-state",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "pageReleased") {
          return sendToScope(
            "browser-sidebar-browser-use-page-released",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "pageClosed") {
          return sendToScope(
            "browser-sidebar-browser-use-page-closed",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "browserUsePresentationRequest") {
          return sendToScope(
            "browser-sidebar-browser-use-presentation-request",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "openNewTab") {
          return sendToScope(
            "browser-sidebar-open-new-tab",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "openSurface") {
          return sendToScope(
            "browser-sidebar-open-surface",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "contextMenuAction") {
          return sendToScope(
            "browser-sidebar-context-menu-action",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "imageDragState") {
          return sendToScope(
            "browser-sidebar-image-drag-state",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "webviewAttached") {
          return sendToScope(
            "browser-sidebar-webview-attached",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        if (event.kind === "destroyWebview") {
          return sendToScope(
            "browser-sidebar-destroy-webview",
            event.value.browserViewScopeId,
            event.value,
          );
        }
        return Effect.void;
      }),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
