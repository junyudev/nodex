import {
  CodexExecutionHostAuthState,
  live as authStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { ElectronNet } from "../platform/electron/ElectronNet";
import { ChatGptDesktop, live } from "./ChatGptDesktop";

const token = (accountId: string) =>
  `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: "user-a" } })).toString("base64url")}.x`;
const input = {
  baseUrl: "https://chatgpt.com/backend-api",
  path: "/dictation/custom_dictionary",
  method: "GET",
  action: "load dictionary",
  expectedAccount: { accountId: "account-a", userId: "user-a" },
};
const make = Effect.fn("ChatGptDesktopTest.make")(function* (
  fetch: ElectronNet["Service"]["fetch"],
  readAccount: (refresh: boolean) => string = () => "account-a",
  requirements: unknown = null,
) {
  const events = yield* PubSub.unbounded<CodexEndpointEvent>();
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 1,
    userAgent: "codex-cli 0.155.0",
  });
  const gateway = CodexGateway.of({
    localHostId: "local",
    events: Stream.fromPubSub(events),
    requestLocal: (_method: string, params: { refreshToken?: boolean }) =>
      Effect.succeed({
        authMethod: "chatgpt",
        authToken: token(readAccount(params.refreshToken === true)),
        requiresOpenaiAuth: true,
      }),
    requestRawOnHost: (_host: string, method: string) =>
      Effect.succeed(
        method === "account/read"
          ? {
              account: { type: "chatgpt", planType: "pro" },
              workspaceRouting: {
                chatgptAccountId: readAccount(false),
                backendOrigin: "https://workspace.example",
                accountRoutingOverride: "us",
              },
            }
          : { requirements },
      ),
  } as unknown as CodexGateway["Service"]);
  const context = yield* Layer.build(
    live.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          authStateLive,
          Layer.succeed(CodexGateway, gateway),
          Layer.succeed(CodexWorkspaceRouting, {
            discover: () => Effect.die("unexpected companion"),
          }),
          Layer.succeed(CodexAppServerCapabilities, {
            forHost: () => Effect.succeed(capability),
            forThread: () => Effect.succeed(capability),
            isCurrent: () => Effect.succeed(true),
          }),
          Layer.succeed(ElectronNet, {
            appVersion: "1.0.0",
            fetch,
            readBase64: () => Effect.die("unused"),
          }),
        ),
      ),
    ),
  );
  return {
    desktop: Context.get(context, ChatGptDesktop),
    authState: Context.get(context, CodexExecutionHostAuthState),
    events,
  };
});

it.effect("routes account-bound requests and never retries a refusal", () =>
  Effect.gen(function* () {
    let count = 0;
    const { desktop } = yield* make((url, init) =>
      Effect.sync(() => {
        count += 1;
        assert.strictEqual(
          url,
          "https://workspace.example/backend-api/dictation/custom_dictionary",
        );
        assert.strictEqual(init.redirect, "error");
        assert.strictEqual(
          new Headers(init.headers).get("X-OpenAI-Account-Routing-Override"),
          "us",
        );
        return new Response(null, { status: 403 });
      }),
    );
    assert.strictEqual((yield* desktop.request(input)).status, 403);
    assert.strictEqual(count, 1);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          desktop.request({
            ...input,
            expectedAccount: { accountId: "account-b", userId: "user-a" },
          }),
        ),
      ),
    );
    assert.strictEqual(count, 1);
  }).pipe(Effect.scoped),
);

it.effect("cancels the first response before the one allowed token refresh", () =>
  Effect.gen(function* () {
    let count = 0;
    let canceled = false;
    const { desktop } = yield* make(
      () =>
        Effect.sync(() => {
          count += 1;
          return count === 1
            ? new Response(
                new ReadableStream({
                  cancel: () => {
                    canceled = true;
                  },
                }),
                { status: 401 },
              )
            : new Response(null, { status: 200 });
        }),
      (refresh) => {
        if (refresh) assert.isTrue(canceled);
        return "account-a";
      },
    );
    assert.strictEqual((yield* desktop.request(input)).status, 200);
    assert.strictEqual(count, 2);
  }).pipe(Effect.scoped),
);

it.effect("rejects same-user workspace drift during refresh without sending a second request", () =>
  Effect.gen(function* () {
    let count = 0;
    let account = "account-a";
    const { desktop } = yield* make(
      () =>
        Effect.sync(() => {
          count += 1;
          return new Response(null, { status: 401 });
        }),
      (refresh) => {
        if (refresh) account = "account-b";
        return account;
      },
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(desktop.request(input))));
    assert.strictEqual(count, 1);
  }).pipe(Effect.scoped),
);

it.effect("aborts an outstanding response body when its account changes", () =>
  Effect.gen(function* () {
    let account = "account-a";
    const { desktop, events } = yield* make(
      () => Effect.succeed(new Response(new ReadableStream())),
      () => account,
    );
    const response = yield* desktop.request(input);
    const body = response.text().then(
      () => false,
      () => true,
    );
    account = "account-b";
    yield* PubSub.publish(events, {
      kind: "notification",
      hostId: "local",
      generation: 1,
      value: {
        protocol: "generated",
        method: "account/updated",
        params: { authMode: "chatgpt", planType: "pro" },
      },
    });
    assert.isTrue(yield* Effect.promise(() => body));
  }).pipe(Effect.scoped),
);

it.effect("fences response bodies and new requests before account mutation notifications", () =>
  Effect.gen(function* () {
    let count = 0;
    const { desktop, authState } = yield* make(() =>
      Effect.sync(() => {
        count += 1;
        return new Response(new ReadableStream());
      }),
    );
    const response = yield* desktop.request(input);
    const body = response.text().then(
      () => false,
      () => true,
    );
    const started = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const mutation = yield* authState
      .withAccountMutation(
        "local",
        "account/sessions/switch",
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    assert.isTrue(yield* Effect.promise(() => body));
    const request = yield* desktop.request(input).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.strictEqual(count, 1);
    yield* Deferred.succeed(done, undefined);
    yield* Fiber.join(mutation);
    yield* Fiber.join(request);
    assert.strictEqual(count, 2);
  }).pipe(Effect.scoped),
);

it.effect("prepares desktop stream headers and routing without an HTTP request", () =>
  Effect.gen(function* () {
    let calls = 0;
    const { desktop, authState } = yield* make(() => {
      calls += 1;
      return Effect.die("Streaming preparation must not fetch");
    });
    const prepared = yield* desktop.prepareRequest({
      ...input,
      path: "/dictation/stream?dictation_surface=composer",
      headers: { "Accept-Language": "zh-CN", "ChatGPT-Account-Id": "incorrect" },
    });
    assert.strictEqual(
      prepared.url,
      "https://workspace.example/backend-api/dictation/stream?dictation_surface=composer",
    );
    assert.strictEqual(prepared.headers.get("Authorization"), `Bearer ${token("account-a")}`);
    assert.strictEqual(prepared.headers.get("ChatGPT-Account-Id"), "account-a");
    assert.strictEqual(prepared.headers.get("originator"), "Codex Desktop");
    assert.isTrue(prepared.headers.get("User-Agent")?.startsWith("Codex Desktop/1.0.0 (") ?? false);
    assert.strictEqual(prepared.headers.get("Accept-Language"), "zh-CN");
    assert.strictEqual(prepared.headers.get("X-OpenAI-Account-Routing-Override"), "us");
    assert.strictEqual(calls, 0);
    assert.isFalse(prepared.signal.aborted);
    yield* authState.withAccountMutation("local", "account/sessions/switch", Effect.void);
    assert.isTrue(prepared.signal.aborted);
  }).pipe(Effect.scoped),
);

it.effect(
  "applies destination permissions to the workspace route before HTTP or stream preparation",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const { desktop } = yield* make(
        () => {
          calls += 1;
          return Effect.succeed(new Response(null));
        },
        () => "account-a",
        {
          application: {
            network: {
              enabled: true,
              domains: { "chatgpt.com": "allow", "workspace.example": "deny" },
            },
          },
        },
      );
      const deniedStream = yield* Effect.flip(
        desktop.prepareRequest({ ...input, path: "/dictation/stream?dictation_surface=composer" }),
      );
      assert.strictEqual(deniedStream._tag, "ChatGptBackendAuthError");
      const deniedHttp = yield* Effect.flip(desktop.request(input));
      assert.strictEqual(deniedHttp._tag, "ChatGptBackendAuthError");
      assert.strictEqual(calls, 0);
      const allowed = yield* make(
        () => {
          calls += 1;
          return Effect.succeed(new Response(null));
        },
        () => "account-a",
        {
          application: {
            network: {
              enabled: true,
              domains: { "chatgpt.com": "deny", "workspace.example": "allow" },
            },
          },
        },
      );
      assert.strictEqual((yield* allowed.desktop.request(input)).status, 200);
      assert.strictEqual(calls, 1);
    }).pipe(Effect.scoped),
);
