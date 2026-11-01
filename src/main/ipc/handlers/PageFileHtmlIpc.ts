import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { parseContentRoutingContext } from "../../../shared/content-routing-context";
import { MainConfig } from "../../app/MainConfig";
import { PageFileHtmlRuntime } from "../../host-runtime/PageFileHtmlRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

const identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));
const admissionInput = Schema.Struct({
  routingContext: Schema.Unknown,
  pageId: identity,
  fileId: identity,
  logicalPath: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  colorScheme: Schema.Literals(["light", "dark"]),
});
const releaseInput = Schema.Struct({
  grant: Schema.String.check(Schema.makeFilter((value) => /^[0-9a-f]{64}$/u.test(value))),
});
export class PageFileHtmlIpcError extends Schema.TaggedError<PageFileHtmlIpcError>()(
  "PageFileHtmlIpcError",
  { cause: Schema.Defect() },
) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;
    const previews = yield* PageFileHtmlRuntime;
    const trusted = (event: Electron.IpcMainInvokeEvent) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "Page File preview", config.rendererUrl),
        catch: (cause) => new PageFileHtmlIpcError({ cause }),
      });
    yield* ipc.handleControl("page-file-html:admit", (event, raw) =>
      Effect.gen(function* () {
        yield* trusted(event);
        const input = yield* Schema.decodeUnknownEffect(admissionInput)(raw);
        const routingContext = yield* Effect.try({
          try: () => parseContentRoutingContext(input.routingContext),
          catch: (cause) => new PageFileHtmlIpcError({ cause }),
        });
        return yield* previews.admit(event.sender, { ...input, routingContext });
      }),
    );
    yield* ipc.handleControl("page-file-html:release", (event, raw) =>
      Effect.gen(function* () {
        yield* trusted(event);
        const input = yield* Schema.decodeUnknownEffect(releaseInput)(raw);
        return previews.release(event.sender, input.grant);
      }),
    );
  }),
);
