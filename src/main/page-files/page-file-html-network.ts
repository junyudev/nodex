import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { Session } from "electron";

export class PageFileHtmlNetworkError extends Schema.TaggedError<PageFileHtmlNetworkError>()(
  "PageFileHtmlNetworkError",
  { cause: Schema.Defect() },
) {}

/**
 * ICE/TURN and speculative connections bypass webRequest. Together with disabled
 * non-proxied WebRTC UDP, a fixed, unreachable proxy prevents these channels from
 * reaching a destination. Port zero cannot have a listening TCP service. There is
 * no DIRECT fallback, including Chromium's implicit loopback bypass.
 */
export const configurePageFileHtmlNetwork = Effect.fn("PageFileHtml.configureNetwork")(function* (
  session: Pick<Session, "setProxy" | "resolveProxy">,
) {
  yield* Effect.tryPromise({
    try: () =>
      session.setProxy({
        mode: "fixed_servers",
        proxyRules: "127.0.0.1:0",
        proxyBypassRules: "<-loopback>",
      }),
    catch: (cause) => new PageFileHtmlNetworkError({ cause }),
  });
  // setProxy updates browser-process preferences before Chromium's network
  // process necessarily observes them. Keep the guest unadmitted while it converges.
  yield* Effect.gen(function* () {
    for (const url of ["https://example.invalid", "http://127.0.0.1", "http://[::1]"]) {
      const proxy = yield* Effect.tryPromise({
        try: () => session.resolveProxy(url),
        catch: (cause) => new PageFileHtmlNetworkError({ cause }),
      });
      if (proxy !== "PROXY 127.0.0.1:0")
        return yield* new PageFileHtmlNetworkError({
          cause: new Error("Page File network isolation is unavailable"),
        });
    }
  }).pipe(Effect.retry({ times: 4, schedule: Schedule.spaced("50 millis") }));
});
