import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { PluginService, PluginServiceAccount, live } from "./PluginService";
import { CodexGateway } from "../codex-runtime/CodexGateway";
const token = (account: string) =>
  `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: account, user_id: "u" } })).toString("base64url")}.x`;
const make = (
  options: {
    authMethod?: string;
    status?: number;
    workspace?: boolean;
    malformed?: boolean;
    changeAccount?: boolean;
  } = {},
) => {
  const calls: { path: string; method: string; account: string | undefined }[] = [];
  let account = "a";
  const desktop = ChatGptDesktop.of({
    authStatus: () =>
      Effect.succeed({
        authMethod: options.authMethod ?? "chatgpt",
        authToken: token(account),
        requiresOpenaiAuth: true,
      }),
    authMethod: Effect.succeed(options.authMethod ?? "chatgpt"),
    prepareRequest: () => Effect.die("unused"),
    request: (input) =>
      Effect.sync(() => {
        calls.push({
          path: input.path,
          method: input.method,
          account: input.expectedAccount?.accountId,
        });
        if (options.changeAccount) account = "b";
        const body = options.malformed
          ? { invalid: true }
          : input.path.includes("/home")
            ? {
                sections: [
                  {
                    id: "curated",
                    title: "Curated",
                    url_slug: "curated",
                    plugins: [{ id: "plugin", display_name: "Plugin" }],
                  },
                ],
              }
            : {
                plugins: [{ id: "plugin", display_name: "Plugin" }],
                pagination: { next_page_token: "next" },
                category: { title: "Design", description: "Tools for design" },
              };
        return Response.json(body, { status: options.status ?? 200 });
      }),
  });
  const gateway = {
    requestLocal: () =>
      Effect.succeed({
        account: { type: "chatgpt", planType: options.workspace ? "business" : "pro" },
      }),
  } as unknown as CodexGateway["Service"];
  return {
    calls,
    layer: live.pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(ChatGptDesktop, desktop), Layer.succeed(CodexGateway, gateway)),
      ),
    ),
  };
};
const withService = <A>(
  h: ReturnType<typeof make>,
  run: (service: PluginService["Service"]) => Effect.Effect<A, unknown>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(h.layer);
      return yield* run(Context.get(context, PluginService));
    }),
  );
it.effect(
  "disables every HTTP capability without ChatGPT auth and never issues an HTTP request",
  () => {
    const h = make({ authMethod: "apikey" });
    return withService(h, (service) =>
      Effect.gen(function* () {
        const access = yield* service.access;
        assert.strictEqual(Object.values(access).some(Boolean), false);
        assert.strictEqual(h.calls.length, 0);
      }),
    );
  },
);
it.effect(
  "resolves endpoint denial as a false capability while selected feeds retain HTTP errors",
  () => {
    const h = make({ status: 403 });
    return withService(h, (service) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* service.access).publicHome, false);
        const result = yield* service.home.pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "policy_denied");
      }),
    );
  },
);
it.effect("rejects malformed service responses and stale account responses", () => {
  const malformed = make({ malformed: true });
  const changed = make({ changeAccount: true });
  return Effect.gen(function* () {
    yield* withService(malformed, (service) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* service.home.pipe(Effect.result))._tag, "Failure");
      }),
    );
    yield* withService(changed, (service) =>
      Effect.gen(function* () {
        const result = yield* service.home.pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") assert.strictEqual(result.failure.code, "account_changed");
      }),
    );
  });
});
it.effect(
  "encodes category search and opaque cursors, preserves metadata and fences remote toggles",
  () => {
    const h = make();
    return withService(h, (service) =>
      Effect.gen(function* () {
        const page = yield* service.category({
          slug: "a/b",
          search: " design tools ",
          cursor: "opaque+cursor",
        });
        assert.strictEqual(page.category?.title, "Design");
        const url = new URL(h.calls[0]!.path, "https://example.com/");
        assert.strictEqual(url.pathname, "/ps/plugin-categories/a%2Fb/plugins");
        assert.strictEqual(url.searchParams.get("q"), "design tools");
        assert.strictEqual(url.searchParams.get("pageToken"), "opaque+cursor");
        assert.strictEqual(url.searchParams.get("scope"), "GLOBAL");
        assert.strictEqual(url.searchParams.get("limit"), "50");
        yield* service.setEnabled("a/b", false);
        assert.deepStrictEqual(h.calls.at(-1), {
          path: "ps/plugins/a%2Fb/disable",
          method: "POST",
          account: "a",
        });
      }),
    );
  },
);
it.effect(
  "checks workspace capability only for workspace accounts and reuses resolved access for a minute",
  () => {
    const h = make({ workspace: true });
    return withService(h, (service) =>
      Effect.gen(function* () {
        const first = yield* service.access;
        assert.strictEqual(first.workspace, true);
        assert.strictEqual(first.shared, true);
        const count = h.calls.length;
        yield* service.access;
        assert.strictEqual(h.calls.length, count);
        assert.strictEqual(
          h.calls.some((call) => call.path.includes("/workspace/shared")),
          true,
        );
      }),
    );
  },
);

it.effect("refuses to retarget a frozen account before dispatch", () => {
  const h = make();
  return withService(h, (service) =>
    Effect.gen(function* () {
      const result = yield* service.home.pipe(
        Effect.provideService(PluginServiceAccount, { accountId: "different", userId: "u" }),
        Effect.result,
      );
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure.code, "account_changed");
      assert.strictEqual(h.calls.length, 0);
    }),
  );
});
