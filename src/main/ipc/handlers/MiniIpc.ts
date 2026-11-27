import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { InboxScopeSchema } from "../../../shared/schemas/inbox-scope";
import { MINI_WINDOW_SIZE } from "../../mini/mini-geometry";
import { RemoteHostedPipRuntime } from "../../host-runtime/RemoteHostedPipRuntime";
import { MiniCompanion } from "../../mini/MiniCompanion";
import { MiniRuntime } from "../../mini/MiniRuntime";
import { DeepLinkRuntime } from "../../host-runtime/DeepLinkRuntime";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime, type WindowRuntimeService } from "../../window-runtime/WindowRuntime";

class MiniIpcError extends Schema.TaggedError<MiniIpcError>()("MiniIpcError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const Id = z.string().trim().min(1).max(512);
const Coverage = z.strictObject({
  chats: z.array(Id),
  turns: z.array(z.strictObject({ pageId: Id, episode: Id })),
  notice: z.boolean(),
});
const Generation = z.number().int().nonnegative();
const ScreenCoordinate = z.number().finite();
// Reports use panel-local CSS pixels. Allow clipped content while bounding the native geometry.
const LayoutCoordinate = (extent: number) =>
  z
    .number()
    .finite()
    .min(-extent)
    .max(2 * extent);
const LayoutRect = z.strictObject({
  x: LayoutCoordinate(MINI_WINDOW_SIZE.width),
  y: LayoutCoordinate(MINI_WINDOW_SIZE.height),
  width: z.number().finite().positive().max(MINI_WINDOW_SIZE.width),
  height: z.number().finite().positive().max(MINI_WINDOW_SIZE.height),
});
const Layout = z.strictObject({ content: LayoutRect, base: LayoutRect }).nullable();
const PreviewVisibility = z.enum(["shown", "hidden"]);
const Drag = z.discriminatedUnion("phase", [
  z.strictObject({ phase: z.literal("start"), x: ScreenCoordinate, y: ScreenCoordinate }),
  z.strictObject({ phase: z.literal("end") }),
]);
const Open = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inbox"), scope: InboxScopeSchema }),
  z.strictObject({ kind: z.literal("page"), pageId: Id }),
  z.strictObject({ kind: z.literal("session"), sessionId: Id }),
]);

export function requireMiniSender(
  event: IpcMainInvokeEvent,
  windows: WindowRuntimeService,
  rendererUrl: string | null = null,
): void {
  requireTrustedAppRendererSender(event, "Mini", rendererUrl);
  if (!windows.hasAuxiliaryRole(event.sender.id, "mini")) {
    throw new Error("Mini controls require the Mini panel");
  }
}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const ipc = yield* ElectronIpc;
    const config = yield* MainConfig;
    const mini = yield* MiniRuntime;
    const previews = yield* RemoteHostedPipRuntime;
    const companion = yield* MiniCompanion;
    const windows = yield* WindowRuntime;
    const links = yield* DeepLinkRuntime;
    const rendererClients = yield* RendererClientRuntime;
    const run = <A>(
      event: IpcMainInvokeEvent,
      operation: string,
      task: (panel: NonNullable<typeof mini.panel>) => A,
    ) =>
      Effect.try({
        try: () => {
          requireMiniSender(event, windows, config.rendererUrl);
          if (!mini.panel) throw new Error("The Mini panel is unavailable");
          return task(mini.panel);
        },
        catch: (cause) => new MiniIpcError({ operation, cause }),
      });
    yield* ipc.handleControl("mini:ready", (event) =>
      run(event, "ready", (panel) => {
        // Keep capability delivery and microphone cleanup on the standard renderer lifetime.
        rendererClients.ensureClient(event.sender);
        panel.ready();
      }).pipe(Effect.andThen(companion.ready(event.sender))),
    );
    yield* ipc.handleControl("mini:layout", (event, input) =>
      run(event, "layout", (panel) => panel.reportLayout(Layout.parse(input))),
    );
    yield* ipc.handleControl("mini:preview-visibility", (event, sessionId, visibility) =>
      run(event, "preview-visibility", () =>
        previews.setChatPreviewVisibility(Id.parse(sessionId), PreviewVisibility.parse(visibility)),
      ).pipe(Effect.flatten),
    );
    yield* ipc.handleControl("mini:pointer", (event, input) =>
      run(event, "pointer", (panel) => panel.pointer(z.boolean().parse(input))),
    );
    yield* ipc.handleControl("mini:drag", (event, input) =>
      run(event, "drag", (panel) => {
        const drag = Drag.parse(input);
        if (drag.phase === "start") panel.beginDrag({ x: drag.x, y: drag.y });
        else panel.endDrag();
      }),
    );
    yield* ipc.handleControl("mini:activity", (event, input) =>
      run(event, "activity", (panel) =>
        panel.apply({ kind: "presence", update: { coverage: Coverage.parse(input) } }),
      ),
    );
    yield* ipc.handleControl("mini:focus", (event) =>
      run(event, "focus", (panel) => panel.apply({ kind: "focus" })),
    );
    yield* ipc.handleControl("mini:release", (event, generation) =>
      run(event, "release", (panel) =>
        panel.apply({ kind: "release", generation: Generation.parse(generation) }),
      ),
    );
    yield* ipc.handleControl("mini:open", (event, input) =>
      Effect.acquireUseRelease(
        run(event, "open", (panel) => {
          const target = Open.parse(input);
          return { target, settle: panel.beginOpen() };
        }),
        ({ target }) => links.openMiniTarget(target),
        ({ settle }, exit) => Effect.sync(() => settle(exit._tag === "Success")),
      ),
    );
  }),
);
