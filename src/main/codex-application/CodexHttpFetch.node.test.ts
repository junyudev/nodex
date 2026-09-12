import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { CODEX_ATTACH_AUTH_HEADER } from "../../shared/codex-http-fetch";
import { ElectronNet, ElectronNetError } from "../platform/electron/ElectronNet";
import { ChatGptDesktop } from "./ChatGptDesktop";
import {
  CodexHttpFetch,
  isCodexDesktopAuthAllowedUrl,
  live as httpFetchLive,
  shouldInferCodexDesktopAuth,
} from "./CodexHttpFetch";

const buildAuthToken = (accountId: string): string => {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    }),
  ).toString("base64url");
  return `${header}.${payload}.signature`;
};

const chatGpt = (authStatus: ChatGptDesktop["Service"]["authStatus"]): ChatGptDesktop["Service"] =>
  ChatGptDesktop.of({
    authStatus,
    authMethod: Effect.succeed("chatgpt"),
    request: () => Effect.die(new Error("Unexpected ChatGPT request")),
  });

const network = (fetch: ElectronNet["Service"]["fetch"]): ElectronNet["Service"] =>
  ElectronNet.of({
    appVersion: "0.0.0-test",
    fetch,
    readBase64: () => Effect.die(new Error("Unexpected base64 read")),
  });

const build = (
  chatgpt: ChatGptDesktop["Service"],
  electronNet: ElectronNet["Service"],
  scope: Scope.Closeable,
) =>
  Layer.buildWithScope(
    httpFetchLive.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(ChatGptDesktop, chatgpt),
          Layer.succeed(ElectronNet, electronNet),
        ),
      ),
    ),
    scope,
  );

it("matches the desktop auth URL and inferred-auth path rules", () => {
  assert.isTrue(isCodexDesktopAuthAllowedUrl("https://chatgpt.com/ces/v1/rgstr"));
  assert.isFalse(isCodexDesktopAuthAllowedUrl("https://ab.chatgpt.com/v1/initialize"));
  assert.isFalse(isCodexDesktopAuthAllowedUrl("https://status.openai.com"));
  assert.isTrue(isCodexDesktopAuthAllowedUrl("http://localhost:8000/wham/test"));
  assert.isTrue(shouldInferCodexDesktopAuth("https://chatgpt.com/backend-api/wham/test"));
  assert.isFalse(shouldInferCodexDesktopAuth("https://chatgpt.com/ces/v1/rgstr"));
});

it.effect("consumes attach-auth and retries a qualifying 401 with a refreshed token", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const refreshes: boolean[] = [];
    const requestHeaders: Headers[] = [];
    const context = yield* build(
      chatGpt((_includeToken, refreshToken) => {
        refreshes.push(refreshToken);
        return Effect.succeed({
          authMethod: "chatgpt",
          authToken: buildAuthToken(refreshToken ? "acct-second" : "acct-first"),
          requiresOpenaiAuth: false,
        });
      }),
      network((_url, init) => {
        requestHeaders.push(new Headers(init.headers));
        return Effect.succeed(
          requestHeaders.length === 1
            ? new Response("unauthorized", { status: 401 })
            : new Response("ok", { status: 200, headers: { "x-result": "yes" } }),
        );
      }),
      scope,
    );
    const service = Context.get(context, CodexHttpFetch);
    const result = yield* service.fetch({
      requestId: "request-1",
      url: "https://chatgpt.com/ces/v1/rgstr",
      method: "POST",
      headers: { [CODEX_ATTACH_AUTH_HEADER]: "1", "content-type": "application/json" },
      body: "{}",
    });

    assert.strictEqual(result.responseType, "success");
    assert.deepStrictEqual(refreshes, [false, true]);
    assert.strictEqual(requestHeaders.length, 2);
    assert.isNull(requestHeaders[0]?.get(CODEX_ATTACH_AUTH_HEADER) ?? null);
    assert.strictEqual(
      requestHeaders[0]?.get("Authorization"),
      `Bearer ${buildAuthToken("acct-first")}`,
    );
    assert.strictEqual(requestHeaders[0]?.get("ChatGPT-Account-Id"), "acct-first");
    assert.isNull(requestHeaders[0]?.get("originator") ?? null);
    assert.isNull(requestHeaders[0]?.get("User-Agent") ?? null);
    assert.strictEqual(
      requestHeaders[1]?.get("Authorization"),
      `Bearer ${buildAuthToken("acct-second")}`,
    );
    assert.strictEqual(requestHeaders[1]?.get("ChatGPT-Account-Id"), "acct-second");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("leaves Statsig AB traffic unauthenticated and rejects unsafe auth attachment", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let authReads = 0;
    let fetches = 0;
    const context = yield* build(
      chatGpt(() => {
        authReads += 1;
        return Effect.succeed({ authMethod: null, authToken: null, requiresOpenaiAuth: false });
      }),
      network((_url, init) => {
        fetches += 1;
        assert.isNull(new Headers(init.headers).get("Authorization"));
        return Effect.succeed(new Response("ok", { status: 200 }));
      }),
      scope,
    );
    const service = Context.get(context, CodexHttpFetch);
    const abResult = yield* service.fetch({
      requestId: "request-ab",
      url: "https://ab.chatgpt.com/v1/initialize",
      method: "POST",
      body: "{}",
    });
    assert.strictEqual(abResult.responseType, "success");
    assert.strictEqual(authReads, 0);
    assert.strictEqual(fetches, 1);

    const unsafeResult = yield* service.fetch({
      requestId: "request-unsafe",
      url: "https://example.com/collect",
      method: "POST",
      headers: { [CODEX_ATTACH_AUTH_HEADER]: "1" },
    });
    assert.deepInclude(unsafeResult, {
      responseType: "error",
      status: 400,
      responseStatus: null,
    });
    assert.strictEqual(authReads, 0);
    assert.strictEqual(fetches, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("cancels the in-flight Electron request by request id", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* build(
      chatGpt(() => Effect.die(new Error("Authentication should not run"))),
      network((_url, init) =>
        Effect.tryPromise({
          try: () =>
            new Promise<Response>((_resolve, reject) => {
              const signal = init.signal;
              if (!signal) throw new Error("Expected an abort signal");
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          catch: (cause) => new ElectronNetError({ operation: "fetch", cause }),
        }),
      ),
      scope,
    );
    const service = Context.get(context, CodexHttpFetch);
    const fiber = yield* Effect.forkChild(
      service.fetch({
        requestId: "request-cancel",
        url: "https://ab.chatgpt.com/v1/initialize",
        method: "GET",
      }),
    );
    yield* Effect.yieldNow;
    yield* service.cancel("request-cancel");
    const result = yield* Fiber.join(fiber);
    assert.deepInclude(result, {
      responseType: "error",
      status: 499,
      responseStatus: null,
    });
    yield* Scope.close(scope, Exit.void);
  }),
);
