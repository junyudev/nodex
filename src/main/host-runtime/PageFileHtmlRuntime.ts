import { SpacePageFileHosts } from "../page-files/SpacePageFileHosts";
import { rendererSpaceParameter } from "../../shared/space-ipc-policy";
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

export const liveForSpace = (spaceId: string | null) =>
  Layer.effect(
    PageFileHtmlRuntime,
    Effect.gen(function* () {
      const library = yield* LibraryModule;
      const hosts = yield* SpacePageFileHosts;
      const host = yield* makePageFileHtmlHost({
        resolver: makePageFileHtmlResolver(library),
        fromPartition: (partition) => session.fromPartition(partition, { cache: false }),
        openExternal: (url) => shell.openExternal(url),
      });
      if (spaceId) {
        yield* hosts.register(spaceId, host);
        return host;
      }
      return {
        ...host,
        createHost: (owner) => {
          const current = () => {
            const space = rendererSpaceParameter(owner.getURL());
            return (
              (space ? hosts.get(space) : undefined)?.createHost(owner) ?? host.createHost(owner)
            );
          };
          return {
            handlesPartition: (partition) => current().handlesPartition(partition),
            handleWillAttach: (event, preferences, params) =>
              current().handleWillAttach(event, preferences, params),
            handleDidAttach: (guest) => current().handleDidAttach(guest),
          };
        },
      } satisfies PageFileHtmlHost;
    }),
  ).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));

export const live = liveForSpace(null);
