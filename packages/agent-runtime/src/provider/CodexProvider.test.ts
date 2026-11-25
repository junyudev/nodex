import { ASYNC_WAIT_TIMEOUT_MS } from "../testUtils/testTimeouts.ts";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CodexSettings } from "@nodex/runtime-contracts";
import { AUTH_PROBE_TIMEOUT_MS } from "@nodex/provider-core/server/snapshotProbe";
import * as Schema from "effect/Schema";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import { vi } from "vite-plus/test";

import {
  applyPreferredCodexDefaultModel,
  checkCodexProviderStatus,
  prepareCodexProviderStatus,
  codexPlanLabel,
  codexProbeStepBudgetMs,
  mapCodexModelCapabilities,
  requestCodexChatGptModels,
  withCodexAppServerClient,
} from "./CodexProvider.ts";

it.live.skipIf(process.platform === "win32")(
  "keeps an app-server probe in the execution process group while startup is pending",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-probe-" });
      const binaryPath = `${home}/probe`;
      yield* fs.writeFileString(
        binaryPath,
        '#!/bin/sh\nprintf "%s" "$$" > probe-pid\nexec /bin/sleep 30\n',
      );
      yield* fs.chmod(binaryPath, 0o700);
      const probe = yield* withCodexAppServerClient({
        binaryPath,
        cwd: home,
        environment: { HOME: home },
      }).pipe(Effect.scoped, Effect.forkChild);
      const pid = yield* fs
        .readFileString(`${home}/probe-pid`)
        .pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout(ASYNC_WAIT_TIMEOUT_MS));
      const group = (id: string) =>
        execFileSync("/bin/ps", ["-o", "pgid=", "-p", id], { encoding: "utf8" }).trim();
      assert.strictEqual(group(pid), group(String(process.pid)));
      yield* Fiber.interrupt(probe);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("labels the current academic research plans", () => {
  assert.equal(codexPlanLabel("sci"), "ChatGPT Academic Researchers Subscription");
  assert.equal(codexPlanLabel("sci_plus"), "ChatGPT Academic Researchers Plus Subscription");
});

it("gives an optional probe step its own limit, but never past the probe's deadline", () => {
  assert.strictEqual(codexProbeStepBudgetMs(3_000, 1_000, 9_000), 3_000);
  assert.strictEqual(codexProbeStepBudgetMs(3_000, 7_000, 9_000), 2_000);
  assert.strictEqual(codexProbeStepBudgetMs(3_000, 9_500, 9_000), 0);
});

it.effect(
  "returns as soon as a slow model list answers without waiting for another cache write",
  () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const answer = yield* Deferred.make<void>();
      let lists = 0;
      // As on a slow network: model/list waits on an online refresh that fails, then answers.
      const client = {
        request: () =>
          Effect.sync(() => (lists += 1)).pipe(
            Effect.andThen(Deferred.succeed(requested, undefined)),
            Effect.andThen(Deferred.await(answer)),
            Effect.as({ data: [], nextCursor: null }),
          ),
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const listing = yield* requestCodexChatGptModels({
        client,
        codexHome: "/nonexistent/codex-home",
        spawnedAtMs: 0,
        deadlineMs: 9_000,
      }).pipe(Effect.forkChild);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("7 seconds");
      yield* Deferred.succeed(answer, undefined);
      assert.deepStrictEqual(yield* Fiber.join(listing), []);
      assert.strictEqual(lists, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const config = Schema.decodeSync(CodexSettings)({ enabled: true });
const rpcError = CodexErrors.CodexAppServerRequestError.internalError(
  "workspace routing discovery failed",
);

type RpcOverrides = Partial<
  Record<
    Parameters<CodexClient.CodexAppServerClient["Service"]["request"]>[0],
    Effect.Effect<unknown, CodexErrors.CodexAppServerError>
  >
>;

function mockCodex(overrides: RpcOverrides = {}) {
  const replies: RpcOverrides = {
    initialize: Effect.succeed({
      codexHome: "/nonexistent/codex-home",
      userAgent: "Codex/0.167.2",
    }),
    getAuthStatus: Effect.succeed({
      authMethod: "chatgpt",
      authToken: null,
      requiresOpenaiAuth: true,
    }),
    "account/read": Effect.succeed({
      account: { type: "chatgpt", email: "test@example.test", planType: "plus" },
      requiresOpenaiAuth: true,
      workspaceRouting: { chatgptAccountId: "workspace-test" },
    }),
    "skills/list": Effect.succeed({ data: [] }),
    "account/rateLimits/read": Effect.fail(rpcError),
    "model/list": Effect.fail(rpcError),
    ...overrides,
  };
  const request = ((method, params: unknown) => {
    if (method === "getAuthStatus") {
      assert.deepStrictEqual(params, { includeToken: false, refreshToken: false });
    }
    return replies[method] ?? Effect.die(new Error(`Unexpected RPC ${method}`));
  }) as CodexClient.CodexAppServerClient["Service"]["request"];
  return () => Effect.succeed({ request, notify: () => Effect.void });
}

it.effect("keeps local credentials and version when ChatGPT account routing fails", () =>
  Effect.gen(function* () {
    const snapshot = yield* checkCodexProviderStatus(
      config,
      mockCodex({
        "account/read": Effect.fail(rpcError),
      }),
    );
    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(snapshot.issue, "account-unavailable");
    assert.strictEqual(snapshot.version, "0.167.2");
    assert.deepStrictEqual(snapshot.auth, {
      status: "authenticated",
      type: "chatgpt",
      label: "ChatGPT",
    });
    assert.include(snapshot.message, rpcError.message);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "a hung account request uses the shared readiness deadline and retains local credentials",
  () =>
    Effect.gen(function* () {
      const checking = yield* checkCodexProviderStatus(
        config,
        mockCodex({
          "account/read": Effect.never,
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(AUTH_PROBE_TIMEOUT_MS - 1);
      assert.isUndefined(checking.pollUnsafe());
      yield* TestClock.adjust(1);
      const snapshot = yield* Fiber.join(checking);
      assert.strictEqual(snapshot.issue, "unresponsive");
      assert.strictEqual(snapshot.version, "0.167.2");
      assert.strictEqual(snapshot.auth.type, "chatgpt");
      assert.strictEqual(snapshot.auth.status, "authenticated");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["failed", "timed out"] as const)(
  "keeps established identity and fallback models when model discovery %s",
  (failure) =>
    Effect.gen(function* () {
      const prepared = yield* prepareCodexProviderStatus(
        { ...config, customModels: ["known-model"] },
        mockCodex({ "model/list": failure === "failed" ? Effect.fail(rpcError) : Effect.never }),
      );
      assert.isTrue("complete" in prepared);
      if (!("complete" in prepared)) return;
      assert.strictEqual(prepared.snapshot.status, "ready");
      assert.strictEqual(prepared.snapshot.models[0]?.slug, "known-model");
      const enrichment = yield* prepared.complete.pipe(Effect.forkChild);
      if (failure === "timed out") {
        assert.isUndefined(enrichment.pollUnsafe());
        yield* TestClock.adjust("7 seconds");
      }
      const settled = yield* Fiber.join(enrichment);
      assert.strictEqual(settled.status, "warning");
      assert.isUndefined(settled.issue);
      assert.strictEqual(settled.version, "0.167.2");
      assert.deepStrictEqual(settled.auth, {
        status: "authenticated",
        type: "chatgpt",
        label: "ChatGPT Plus Subscription",
        email: "test@example.test",
        workspaceId: "workspace-test",
      });
      assert.deepStrictEqual(settled.models, prepared.snapshot.models);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reads the account when this computer's sign-in can't be read", () =>
  Effect.gen(function* () {
    const prepared = yield* prepareCodexProviderStatus(
      config,
      // An app-server that doesn't know the request, or answers it in a shape that can't be read.
      mockCodex({ getAuthStatus: Effect.fail(rpcError) }),
    );
    assert.isTrue("complete" in prepared);
    if (!("complete" in prepared)) return;
    assert.strictEqual(prepared.snapshot.auth.status, "authenticated");
    assert.strictEqual(prepared.snapshot.auth.email, "test@example.test");
    assert.isUndefined(prepared.snapshot.issue);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports sign-out without reading account or waiting for the catalog", () =>
  Effect.gen(function* () {
    let catalogReads = 0;
    const prepared = yield* prepareCodexProviderStatus(
      config,
      mockCodex({
        getAuthStatus: Effect.succeed({
          authMethod: null,
          authToken: null,
          requiresOpenaiAuth: true,
        }),
        "account/read": Effect.die("account read would go online"),
        "model/list": Effect.sync(() => {
          catalogReads += 1;
          return {
            data: [
              {
                model: "gpt-test",
                displayName: "GPT Test",
                isDefault: true,
                supportedReasoningEfforts: [],
              },
            ],
            nextCursor: null,
          };
        }),
      }),
    );
    assert.isTrue("complete" in prepared);
    if (!("complete" in prepared)) return;
    const { snapshot } = prepared;
    assert.strictEqual(catalogReads, 0);
    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(snapshot.auth.status, "unauthenticated");
    assert.strictEqual(snapshot.version, "0.167.2");
    assert.isUndefined(snapshot.issue);
    const completed = yield* prepared.complete;
    assert.strictEqual(catalogReads, 1);
    assert.deepStrictEqual(completed.auth, snapshot.auth);
    assert.deepStrictEqual(
      completed.models.map(({ slug }) => slug),
      ["gpt-test"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([true, false])(
  "completes first-stage readiness for an API key or provider without OpenAI auth (requires OpenAI: %s)",
  (requiresOpenaiAuth) =>
    Effect.gen(function* () {
      const prepared = yield* prepareCodexProviderStatus(
        { ...config, customModels: ["known-model"] },
        mockCodex({
          getAuthStatus: Effect.succeed({
            authMethod: requiresOpenaiAuth ? "apikey" : null,
            authToken: null,
            requiresOpenaiAuth,
          }),
          "account/read": Effect.succeed({
            account: requiresOpenaiAuth ? { type: "apiKey" } : null,
            requiresOpenaiAuth,
          }),
          "account/rateLimits/read": Effect.die("these accounts have no ChatGPT usage"),
        }),
      );
      assert.isTrue("complete" in prepared);
      if (!("complete" in prepared)) return;
      const { snapshot } = prepared;
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.auth.status, requiresOpenaiAuth ? "authenticated" : "unknown");
      assert.strictEqual(snapshot.auth.type, requiresOpenaiAuth ? "apiKey" : undefined);
      const complete = yield* prepared.complete;
      assert.strictEqual(complete.usageLimits?.unavailable?.reason, "unsupported");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "includes a bounded, sanitized stderr tail after early exit",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-probe-exit-" });
      const binaryPath = `${home}/probe`;
      yield* fs.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          `printf '%s\n' '${"a".repeat(4_500)}' >&2`,
          "printf 'sk-exampleSecret123\nAuthorization: Basic exampleBasicSecret\n\\033[31mCannot parse config\\033[0m\n' >&2",
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o700);
      const snapshot = yield* checkCodexProviderStatus({ ...config, binaryPath, homePath: home });
      assert.strictEqual(snapshot.status, "error");
      assert.strictEqual(snapshot.issue, "failed");
      assert.isTrue(snapshot.installed);
      assert.strictEqual(snapshot.version, null);
      assert.include(snapshot.message, "Cannot parse config");
      assert.notMatch(snapshot.message ?? "", /exampleSecret|exampleBasicSecret|\u001b|aaaaa/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "keeps host provider variables out of an isolated app-server probe",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-isolated-probe-" });
      const binaryPath = home + "/probe";
      const outputPath = home + "/probe-env";
      const probeSettings = { ...config, binaryPath, homePath: home };
      yield* fs.writeFileString(
        binaryPath,
        [
          "#!/bin/sh",
          "{",
          "if printenv OPENAI_API_KEY >/dev/null; then echo host-key; fi",
          "if printenv NODEX_CODEX_LAUNCH_ARGS >/dev/null; then echo host-args; fi",
          'echo "$NODEX_TEST_PROBE_ENV"',
          '} > "$NODEX_TEST_PROBE_OUTPUT"',
          "exit 1",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(binaryPath, 0o700);

      vi.stubEnv("OPENAI_API_KEY", "test-host-key");
      vi.stubEnv("NODEX_CODEX_LAUNCH_ARGS", "--enable host-override");
      vi.stubEnv("NODEX_TEST_PROBE_ENV", "retained");
      vi.stubEnv("NODEX_TEST_PROBE_OUTPUT", outputPath);
      try {
        yield* checkCodexProviderStatus({ ...probeSettings, isolated: true });
        assert.equal(yield* fs.readFileString(outputPath), "retained\n");

        yield* checkCodexProviderStatus(probeSettings);
        assert.equal(yield* fs.readFileString(outputPath), "host-key\nhost-args\nretained\n");
      } finally {
        vi.unstubAllEnvs();
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("maps current Codex model capability fields", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: [],
    defaultReasoningEffort: "super-high",
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    defaultServiceTier: "flex",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "Lower latency responses.",
      },
      {
        id: "flex",
        name: "Flex",
        description: "Lower-cost asynchronous routing.",
      },
    ],
    supportedReasoningEfforts: [
      {
        description: "Maximum reasoning",
        reasoningEffort: "super-high",
      },
    ],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [{ id: "super-high", label: "super-high", isDefault: true }],
      currentValue: "super-high",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard" },
        {
          id: "priority",
          label: "Fast",
          description: "Lower latency responses.",
        },
        {
          id: "flex",
          label: "Flex",
          description: "Lower-cost asynchronous routing.",
          isDefault: true,
        },
      ],
      currentValue: "flex",
    },
  ]);
});

it("uses standard routing when the catalog has no default service tier", () => {
  const capabilities = mapCodexModelCapabilities({
    additionalSpeedTiers: ["fast"],
    defaultReasoningEffort: "medium",
    defaultServiceTier: null,
    description: "Test model",
    displayName: "GPT Test",
    hidden: false,
    id: "gpt-test",
    isDefault: true,
    model: "gpt-test",
    serviceTiers: [
      {
        id: "priority",
        name: "Fast",
        description: "1.5x speed, increased usage",
      },
      {
        id: "ultrafast",
        name: "Ultrafast",
        description: "The fastest available responses for latency-sensitive work.",
      },
    ],
    supportedReasoningEfforts: [],
  });

  assert.deepStrictEqual(capabilities.optionDescriptors, [
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        {
          id: "priority",
          label: "Fast",
          description: "1.5x speed, increased usage",
        },
        {
          id: "ultrafast",
          label: "Ultrafast",
          description: "Even faster, more expensive",
        },
      ],
      currentValue: "default",
    },
  ]);
});

it("marks the most preferred available model as default", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(
    models.map((model) => ({ slug: model.slug, isDefault: model.isDefault })),
    [
      { slug: "gpt-5.6-terra", isDefault: true },
      { slug: "gpt-5.4", isDefault: undefined },
    ],
  );
});

it("prefers sol over terra when both are available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isCustom: false, capabilities: null },
    { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.6-sol");
});

it("ranks qualified Codex models while preserving their wire ids", () => {
  const models = applyPreferredCodexDefaultModel([
    {
      slug: "openai.gpt-5.6-luna",
      name: "Luna",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    { slug: "openai.gpt-5.6-sol", name: "Sol", isCustom: false, capabilities: null },
  ]);
  assert.deepStrictEqual(
    models.filter((model) => model.isDefault).map((model) => model.slug),
    ["openai.gpt-5.6-sol"],
  );
});

it("keeps Codex's own default when no preferred model is available", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});

it("ignores custom models that shadow a preferred slug", () => {
  const models = applyPreferredCodexDefaultModel([
    { slug: "gpt-5.6-sol", name: "gpt-5.6-sol", isCustom: true, capabilities: null },
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, isDefault: true, capabilities: null },
  ]);

  assert.deepStrictEqual(models.find((model) => model.isDefault)?.slug, "gpt-5.4");
});
