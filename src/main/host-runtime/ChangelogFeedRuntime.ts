import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  CHANGELOG_FEED_URL,
  decodeChangelogFeed,
  type ChangelogFeed,
} from "../../shared/changelog-feed";
import { MainConfig } from "../app/MainConfig";

class ChangelogFeedRuntimeError extends Schema.TaggedError<ChangelogFeedRuntimeError>()(
  "ChangelogFeedRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ChangelogFeedRuntime extends Context.Service<
  ChangelogFeedRuntime,
  { readonly read: Effect.Effect<ChangelogFeed, ChangelogFeedRuntimeError> }
>()("nodex/main/host-runtime/ChangelogFeedRuntime") {}

function resolveFeedUrl(config: MainConfig["Service"]): URL {
  const override = config.isPackaged
    ? undefined
    : config.environment.NODEX_CHANGELOG_FEED_URL?.trim();
  const url = new URL(override || CHANGELOG_FEED_URL);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/u.test(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("The changelog feed URL must use HTTPS or loopback HTTP without credentials.");
  }
  return url;
}

export const layer = (
  request: (url: URL) => Effect.Effect<unknown, Error>,
): Layer.Layer<ChangelogFeedRuntime, never, MainConfig> =>
  Layer.effect(
    ChangelogFeedRuntime,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const lastGood = yield* Ref.make<ChangelogFeed | undefined>(undefined);
      const refresh = Effect.gen(function* () {
        const url = yield* Effect.try({
          try: () => resolveFeedUrl(config),
          catch: (cause) => new ChangelogFeedRuntimeError({ operation: "resolve-url", cause }),
        });
        const payload = yield* request(url).pipe(
          Effect.timeout("10 seconds"),
          Effect.mapError(
            (cause) => new ChangelogFeedRuntimeError({ operation: "download", cause }),
          ),
        );
        return yield* Effect.try({
          try: () => decodeChangelogFeed(payload),
          catch: (cause) => new ChangelogFeedRuntimeError({ operation: "decode", cause }),
        });
      });

      const cached = yield* refresh.pipe(
        Effect.tap((feed) => Ref.set(lastGood, feed)),
        Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0)),
      );
      const read = cached.pipe(
        Effect.catch((error) =>
          Ref.get(lastGood).pipe(
            Effect.flatMap((feed) => (feed ? Effect.succeed(feed) : Effect.fail(error))),
          ),
        ),
      );
      return ChangelogFeedRuntime.of({ read });
    }),
  );
