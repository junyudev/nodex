import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import type { components } from "@nodex/core-protocol";
import { make } from "./ChannelSender";
import { GitHubChannelAdapter, ChannelSendError } from "./GitHubChannelAdapter";
import { item } from "./channel-test-fixture";
it.effect("claims before sending and preserves lost-reply reconciliation across workers", () =>
  Effect.gen(function* () {
    const commands: components["schemas"]["SourceCommand"][] = [];
    let count = 0;
    const makeWorker = make.pipe(
      Effect.provideService(CoreModules, {
        workspace: {
          read: () =>
            Effect.succeed({
              value: {
                kind: "sources",
                value: { kind: "channel_outbox", items: [{ ...item, attempts: count }] },
              },
            }),
          apply: ({ intent }: { intent: { command: components["schemas"]["SourceCommand"] } }) =>
            Effect.sync(() => {
              commands.push(intent.command);
            }),
        },
      } as unknown as CoreModules["Service"]),
      Effect.provideService(GitHubChannelAdapter, {
        send: (current) =>
          Effect.gen(function* () {
            assert.equal(commands.at(-1)?.kind, "claim_channel_send");
            count++;
            if (current.attempts === 0)
              return yield* new ChannelSendError({
                reason: "Unknown outcome",
                permanent: false,
                credentialInvalid: false,
              });
            return {
              comment_id: "77",
              url: "https://github.com/alice/repo/issues/7#issuecomment-77",
            };
          }),
      }),
    );
    yield* (yield* makeWorker).drain;
    yield* (yield* makeWorker).drain;
    const settlements = commands.filter((c) => c.kind === "settle_channel_send");
    assert.equal(settlements.length, 2);
    assert.equal(settlements[0]?.receipt, null);
    assert.equal(settlements[1]?.receipt?.comment_id, "77");
  }),
);
