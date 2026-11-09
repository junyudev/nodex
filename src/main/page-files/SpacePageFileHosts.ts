import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { PageFileHtmlHost } from "./page-file-html-host";

/** The window's native guest gate delegates to the admitted Space's content owner. */
export class SpacePageFileHosts extends Context.Service<
  SpacePageFileHosts,
  {
    readonly get: (spaceId: string) => PageFileHtmlHost | undefined;
    readonly register: (
      spaceId: string,
      host: PageFileHtmlHost,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/page-files/SpacePageFileHosts") {}

export const live = Layer.effect(
  SpacePageFileHosts,
  Effect.sync(() => {
    const hosts = new Map<string, PageFileHtmlHost>();
    return SpacePageFileHosts.of({
      get: (spaceId) => hosts.get(spaceId),
      register: (spaceId, host) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            hosts.set(spaceId, host);
          }),
          () =>
            Effect.sync(() => {
              if (hosts.get(spaceId) === host) hosts.delete(spaceId);
            }),
        ),
    });
  }),
);
