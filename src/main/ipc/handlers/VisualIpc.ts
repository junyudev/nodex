import { createVisualService } from "../../visual/VisualService";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";
import { parseContentRoutingContext } from "../../../shared/content-routing-context";
import { VISUAL_LIMITS } from "../../../shared/visual/contract";
import { compileVisual } from "../../../shared/visual/native";
import { VisualGuestHost } from "../../visual/VisualGuestHost";
import { CoreModules } from "../../core-runtime/CoreModules";
import { LibraryModule } from "../../library-application/LibraryModule";
import { MainConfig } from "../../app/MainConfig";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { refreshVisualQuery } from "../../visual/VisualQueryRefresh";
import { visualPageReader } from "../../visual/VisualPageSources";
import { noVisualPage, resolveVisualSources } from "../../visual/VisualSources";
import type { VisualPreviewResult } from "../../../shared/visual/bridge";

const grantSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sourceSchema = z.string().max(VISUAL_LIMITS.textBytes);
const themeSchema = z.object({
  appearance: z.enum(["light", "dark"]),
  variables: z.record(z.string().regex(/^--[\w-]+$/u), z.string().max(1024)),
});
function requireSender(event: Electron.IpcMainInvokeEvent, config: MainConfig["Service"]) {
  return Effect.try({
    try: () => requireTrustedAppRendererSender(event, "Visual", config.rendererUrl),
    catch: () => new Error("Visual renderer is unavailable"),
  });
}
const rejected = (message: string, retired?: true): VisualPreviewResult => ({
  retired,
  status: "error",
  diagnostics: [{ severity: "error", code: "render", message }],
});

export const guestControls = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const host = yield* VisualGuestHost;
    yield* ipc.handleControl("app:visual:admit", (event) =>
      requireSender(event, config).pipe(Effect.andThen(host.admit(event.sender))),
    );
    yield* ipc.handleControl("app:visual:release", (event, grant) =>
      Effect.gen(function* () {
        yield* requireSender(event, config);
        return host.release(event.sender, grantSchema.parse(grant));
      }),
    );
    yield* ipc.handleControl("app:visual:render", (event, input) =>
      Effect.gen(function* () {
        yield* requireSender(event, config);
        const grant = grantSchema.parse(input.grant);
        const guest = host.get(event.sender, grant);
        if (!guest) return rejected("Visual guest is unavailable", true);
        const compiled = compileVisual(sourceSchema.parse(input.source));
        if (!compiled.ok) return { status: "error" as const, diagnostics: compiled.diagnostics };
        if (!guest.canRender()) return { status: "renew" as const };
        const theme = themeSchema.parse(input.theme);
        if (
          JSON.stringify(input.rows).length > VISUAL_LIMITS.resolvedBytes * 2 ||
          Object.keys(theme.variables).length > 128
        )
          return rejected("Visual data exceeded its budget");
        const rendered = yield* guest
          .render(compiled.code, compiled.program, input.rows, theme)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!rendered) {
          host.release(event.sender, grant);
          return rejected("Visual rendering timed out or was interrupted", true);
        }
        if (rendered.status === "error") {
          const { location } = rendered;
          return {
            status: "error" as const,
            diagnostics: [
              ...compiled.diagnostics,
              {
                severity: "error" as const,
                code: "render",
                message: rendered.message,
                span: location ? compiled.locate(location.line, location.column) : undefined,
              },
            ],
          };
        }
        return {
          status: "rendered" as const,
          frame: rendered.frame,
          diagnostics: [...compiled.diagnostics, ...rendered.frame.diagnostics],
        };
      }),
    );
  }),
);

export const sourceControls = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const modules = yield* CoreModules;
    const library = yield* LibraryModule;
    const service = createVisualService();
    const reader = (page: import("../../../shared/visual/bridge").VisualPageContext | null) =>
      page
        ? visualPageReader({
            modules,
            library,
            route: parseContentRoutingContext(page.routingContext),
            pageId: z.string().min(1).max(512).parse(page.pageId),
          })
        : noVisualPage;
    yield* ipc.handleControl("visual:capture", (event, source, page, appearances) =>
      Effect.gen(function* () {
        yield* requireSender(event, config);
        const themes = z
          .array(z.enum(["light", "dark"]))
          .min(1)
          .max(2)
          .parse(appearances);
        return yield* service.check(
          sourceSchema.parse(source),
          ({ program }) => resolveVisualSources(program, reader(page)),
          themes,
        );
      }),
    );

    yield* ipc.handleControl("visual:refresh-query", (event, input) =>
      Effect.gen(function* () {
        yield* requireSender(event, config);
        const parsed = z
          .object({
            source: sourceSchema,
            page: z.object({ pageId: z.string().min(1).max(512), routingContext: z.unknown() }),
            figure: z.number().int().nonnegative(),
            sourceName: z.string().min(1),
          })
          .parse(input);
        return yield* refreshVisualQuery(
          {
            ...parsed,
            page: {
              ...parsed.page,
              routingContext: parseContentRoutingContext(parsed.page.routingContext),
            },
          },
          modules.query,
          library,
        );
      }),
    );

    yield* ipc.handleControl("visual:resolve-sources", (event, source, page) =>
      Effect.gen(function* () {
        yield* requireSender(event, config);
        const compiled = compileVisual(sourceSchema.parse(source));
        if (!compiled.ok) return { ok: false as const, diagnostics: compiled.diagnostics };
        return yield* resolveVisualSources(compiled.program, reader(page)).pipe(
          Effect.map((rows) => ({ ok: true as const, rows, figures: compiled.program.figures })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false as const,
              diagnostics: [
                {
                  severity: "error" as const,
                  code: "source",
                  message:
                    error instanceof Error
                      ? error.message
                      : "A Visual source could not be resolved",
                },
              ],
            }),
          ),
        );
      }),
    );
  }),
);
