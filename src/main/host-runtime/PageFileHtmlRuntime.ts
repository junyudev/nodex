import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { session, shell } from "electron";
import { LibraryModule } from "../library-application/LibraryModule";
import { makePageFileHtmlHost, type PageFileHtmlHost } from "../page-files/page-file-html-host";
import { makePageFileHtmlResolver } from "../page-files/page-file-html-resolver";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";

export class PageFileHtmlRuntime extends Context.Service<PageFileHtmlRuntime, PageFileHtmlHost>()(
  "nodex/main/host-runtime/PageFileHtmlRuntime",
) {}

export const live = Layer.effect(
  PageFileHtmlRuntime,
  Effect.gen(function* () {
    const library = yield* LibraryModule;
    return yield* makePageFileHtmlHost({
      resolver: makePageFileHtmlResolver(library),
      fromPartition: (partition) => session.fromPartition(partition, { cache: false }),
      openExternal: (url) => shell.openExternal(url),
    });
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
