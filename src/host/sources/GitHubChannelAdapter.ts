import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  GitHubApi,
  PinnedGitHubCredential,
  SourceAccount,
  type GitHubApiError,
} from "@nodex/agent-runtime/github-source";
import type { components } from "@nodex/core-protocol";
type Model = components["schemas"];
type Item = Model["ChannelOutboxItem"];
export class ChannelSendError extends Schema.TaggedError<ChannelSendError>()("ChannelSendError", {
  reason: Schema.String,
  permanent: Schema.Boolean,
  credentialInvalid: Schema.Boolean,
}) {}
const failure = (reason: string, permanent = false, credentialInvalid = false) =>
  new ChannelSendError({ reason, permanent, credentialInvalid });
const classify = (error: GitHubApiError) => {
  if (error._tag === "GitHubApiAuthenticationError" || error._tag === "GitHubNotSignedInError")
    return failure("Reconnect GitHub", false, true);
  if (error._tag === "GitHubApiNotFoundError")
    return failure("Access to the origin thread was lost", true);
  if (error._tag === "GitHubApiResponseError" && [403, 410, 422].includes(error.status))
    return failure("GitHub no longer permits this reply", true);
  return failure("GitHub reply could not be confirmed");
};
const comment = z.object({
  id: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullish(),
});
const parse = <T>(schema: z.ZodType<T>, body: string) =>
  Effect.try({
    try: () => schema.parse(JSON.parse(body)),
    catch: () => failure("GitHub returned an unreadable response"),
  });
export class GitHubChannelAdapter extends Context.Service<
  GitHubChannelAdapter,
  { send: (item: Item) => Effect.Effect<Model["ChannelReceipt"], ChannelSendError> }
>()("nodex/GitHubChannelAdapter") {}
/** Reconcile every earlier attempt through its marker before considering another POST. */
export const makeGitHubChannelAdapter = (api: GitHubApi["Service"]) =>
  GitHubChannelAdapter.of({
    send: Effect.fn("GitHubChannelAdapter.send")(function* (item: Item) {
      const config = item.source.config;
      const credential = yield* api.credential(config.host).pipe(
        Effect.provideService(SourceAccount, config.account_login),
        Effect.mapError(() => failure("Reconnect GitHub", false, true)),
      );
      const rest = (path: string, body?: unknown) =>
        api
          .rest({
            host: config.host,
            path,
            operation: "channel.origin",
            ...(body === undefined ? {} : { method: "POST" as const, body }),
            maxResponseBytes: 2 * 1024 * 1024,
          })
          .pipe(
            Effect.mapError(classify),
            Effect.flatMap((response) =>
              response.truncated || response.invalidUtf8
                ? Effect.fail(failure("GitHub response is incomplete"))
                : Effect.succeed(response.body),
            ),
          );
      return yield* Effect.gen(function* () {
        const account = yield* rest("user").pipe(
          Effect.flatMap((body) =>
            parse(z.object({ id: z.number().int(), login: z.string() }), body),
          ),
        );
        if (
          String(account.id) !== config.account_id ||
          account.login.toLowerCase() !== config.account_login.toLowerCase()
        )
          return yield* failure(
            "GitHub account changed; reconnect the original account",
            false,
            true,
          );
        const repo = yield* rest(`repos/${item.thread.repository}`).pipe(
          Effect.flatMap((body) => parse(z.object({ id: z.number().int() }), body)),
        );
        if (String(repo.id) !== item.thread.repository_id)
          return yield* failure("The origin repository identity changed", true);
        const path = `repos/${item.thread.repository}/issues/${item.thread.number}`;
        if (item.attempts > 0) {
          let complete = false;
          for (let page = 1; page <= 10000; page++) {
            const comments = yield* rest(`${path}/comments?per_page=100&page=${page}`).pipe(
              Effect.flatMap((body) => parse(z.array(comment), body)),
            );
            const found = comments.find((c) => c.body?.includes(item.marker));
            if (found) return { comment_id: String(found.id), url: found.html_url };
            if (comments.length < 100) {
              complete = true;
              break;
            }
          }
          if (!complete) return yield* failure("The origin thread could not be fully reconciled");
        }
        const thread = yield* rest(path).pipe(
          Effect.flatMap((body) => parse(z.object({ locked: z.boolean() }), body)),
        );
        if (thread.locked) return yield* failure("The origin thread is locked", true);
        const receipt = yield* rest(`${path}/comments`, {
          body: `${item.body}\n\n${item.marker}`,
        }).pipe(Effect.flatMap((body) => parse(comment, body)));
        return { comment_id: String(receipt.id), url: receipt.html_url };
      }).pipe(
        Effect.provideService(PinnedGitHubCredential, {
          host: config.host,
          token: credential.token,
          credentialFingerprint: credential.fingerprint,
        }),
      );
    }),
  });
export const live = Layer.effect(
  GitHubChannelAdapter,
  Effect.map(GitHubApi, makeGitHubChannelAdapter),
);
