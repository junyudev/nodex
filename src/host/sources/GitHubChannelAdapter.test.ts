import { assert, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import type { GitHubApi, GitHubRestInput } from "@nodex/agent-runtime/github-source";
import { makeGitHubChannelAdapter } from "./GitHubChannelAdapter";
import { item } from "./channel-test-fixture";
const fake = (respond: (request: GitHubRestInput) => unknown) => {
  const calls: GitHubRestInput[] = [];
  const api = {
    credential: () =>
      Effect.succeed({ token: Redacted.make("test-only"), fingerprint: "fingerprint" }),
    rest: (request: GitHubRestInput) =>
      Effect.sync(() => {
        calls.push(request);
        const body =
          request.path === "user"
            ? { id: 1, login: "alice" }
            : request.path === "repos/alice/repo"
              ? { id: 10 }
              : respond(request);
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(body),
          truncated: false,
          invalidUtf8: false,
        };
      }),
  } as unknown as GitHubApi["Service"];
  return { adapter: makeGitHubChannelAdapter(api), calls };
};
it.effect("posts the frozen body and marker on both issue and PR origins", () =>
  Effect.gen(function* () {
    const f = fake((r) =>
      r.method === "POST"
        ? { id: 77, html_url: "https://github.com/alice/repo/issues/7#issuecomment-77", body: "" }
        : { locked: false },
    );
    for (const kind of ["issue", "pull_request"] as const)
      yield* f.adapter.send({ ...item, thread: { ...item.thread, kind } });
    const posts = f.calls.filter((r) => r.method === "POST");
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.path, "repos/alice/repo/issues/7/comments");
    assert.deepEqual(posts[0]!.body, { body: `${item.body}\n\n${item.marker}` });
  }),
);
it.effect("reconciles an unknown outcome through every comment page before resending", () =>
  Effect.gen(function* () {
    const f = fake((r) =>
      r.path.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            html_url: `https://github.com/alice/repo/issues/7#issuecomment-${i + 1}`,
            body: "Personal comment",
          }))
        : r.path.endsWith("page=2")
          ? [
              {
                id: 777,
                html_url: "https://github.com/alice/repo/issues/7#issuecomment-777",
                body: `Posted ${item.marker}`,
              },
            ]
          : { locked: true },
    );
    const receipt = yield* f.adapter.send({ ...item, attempts: 1 });
    assert.equal(receipt.comment_id, "777");
    assert.equal(f.calls.filter((r) => r.method === "POST").length, 0);
    assert.isTrue(f.calls.some((r) => r.path.endsWith("page=2")));
  }),
);
it.effect("checks a complete negative reconciliation before another POST", () =>
  Effect.gen(function* () {
    const f = fake((r) =>
      r.path.includes("per_page")
        ? []
        : r.method === "POST"
          ? { id: 77, html_url: "https://github.com/alice/repo/issues/7#issuecomment-77", body: "" }
          : { locked: false },
    );
    yield* f.adapter.send({ ...item, attempts: 2 });
    assert.isTrue(
      f.calls.findIndex((r) => r.path.includes("per_page")) <
        f.calls.findIndex((r) => r.method === "POST"),
    );
  }),
);
it.effect("keeps locked threads and replaced repository identities terminal", () =>
  Effect.gen(function* () {
    const locked = fake(() => ({ locked: true }));
    const result = yield* locked.adapter.send(item).pipe(Effect.result);
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.isTrue(result.failure.permanent);
    assert.equal(locked.calls.filter((r) => r.method === "POST").length, 0);
    const replaced = fake(() => ({ locked: false }));
    const replacement = yield* replaced.adapter
      .send({ ...item, thread: { ...item.thread, repository_id: "99" } })
      .pipe(Effect.result);
    assert.equal(replacement._tag, "Failure");
    if (replacement._tag === "Failure") assert.isTrue(replacement.failure.permanent);
  }),
);
