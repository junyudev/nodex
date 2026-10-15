import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { GetAuthStatusResponse } from "../../../packages/codex-app-server-protocol/src/GetAuthStatusResponse";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { make } from "./AgentRuntimeProviderAuthentication";

const token = (accountId: string) =>
  `header.${Buffer.from(JSON.stringify({ exp: 2_000_000_000, "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: "user" } })).toString("base64url")}.signature`;
const fixture = () => {
  const controller = new AbortController();
  const requests: unknown[] = [];
  const state = {
    active: true,
    status: {
      authMethod: "chatgpt",
      authToken: token("account"),
      requiresOpenaiAuth: true,
    } as GetAuthStatusResponse,
    retireDuringRead: false,
  };
  const gateway = {
    localHostId: "local",
    requestLocal: (_method: string, params: unknown) =>
      Effect.sync(() => {
        requests.push(params);
        if (state.retireDuringRead) controller.abort();
        return state.status;
      }),
  } as unknown as CodexGateway["Service"];
  const accounts = {
    backendLease: () => Effect.succeed(controller.signal),
  } as unknown as CodexExecutionHostAuthState["Service"];
  const read = make().pipe(
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexExecutionHostAuthState, accounts),
  );
  return {
    read,
    state,
    requests,
    input: { refresh: false, previousAccountId: null, isActive: () => state.active },
  };
};

it.effect(
  "borrows current ChatGPT and API-key credentials without persisting an account store",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const read = yield* f.read;
      assert.deepStrictEqual(yield* read(f.input), {
        kind: "chatgpt",
        accessToken: token("account"),
        accountId: "account",
        planType: null,
      });
      assert.deepStrictEqual(
        yield* read({ ...f.input, refresh: true, previousAccountId: "account" }),
        { kind: "chatgpt", accessToken: token("account"), accountId: "account", planType: null },
      );
      assert.deepStrictEqual(f.requests, [
        { includeToken: true, refreshToken: false },
        { includeToken: true, refreshToken: true },
      ]);
      f.state.status = {
        authMethod: "apikey",
        authToken: "fixture-api-key",
        requiresOpenaiAuth: true,
      };
      assert.deepStrictEqual(yield* read(f.input), { kind: "api-key", key: "fixture-api-key" });
      f.state.status = { authMethod: null, authToken: null, requiresOpenaiAuth: false };
      assert.deepStrictEqual(yield* read(f.input), { kind: "external" });
    }),
);

it.effect("never refreshes a prior Session under a different configured account", () =>
  Effect.gen(function* () {
    const f = fixture();
    const read = yield* f.read;
    assert.isTrue(
      Exit.isFailure(
        yield* read({ ...f.input, refresh: true, previousAccountId: "other-account" }).pipe(
          Effect.exit,
        ),
      ),
    );
    f.state.status = { authMethod: null, authToken: null, requiresOpenaiAuth: true };
    assert.isTrue(Exit.isFailure(yield* read(f.input).pipe(Effect.exit)));
  }),
);

it.effect("withholds credentials from retired account and runtime lifetimes", () =>
  Effect.gen(function* () {
    const f = fixture();
    const read = yield* f.read;
    f.state.active = false;
    assert.isTrue(Exit.isFailure(yield* read(f.input).pipe(Effect.exit)));
    assert.lengthOf(f.requests, 0);
    f.state.active = true;
    f.state.retireDuringRead = true;
    assert.isTrue(Exit.isFailure(yield* read(f.input).pipe(Effect.exit)));
  }),
);
