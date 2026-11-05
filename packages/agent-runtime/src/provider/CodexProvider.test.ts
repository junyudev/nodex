import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";

import {
  applyPreferredCodexDefaultModel,
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
        .pipe(Effect.retry(Schedule.spaced("20 millis")), Effect.timeout("5 seconds"));
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
  "keeps the listed catalog at the probe's deadline when a slow online refresh never lands",
  () =>
    Effect.gen(function* () {
      let lists = 0;
      // As on a slow network: model/list waits on an online refresh that fails, then answers.
      const client = {
        request: () =>
          Effect.sleep("7 seconds").pipe(
            Effect.tap(() => Effect.sync(() => (lists += 1))),
            Effect.as({ data: [], nextCursor: null }),
          ),
      } as unknown as CodexClient.CodexAppServerClient["Service"];
      const listing = yield* requestCodexChatGptModels({
        client,
        codexHome: "/nonexistent/codex-home",
        spawnedAtMs: 0,
        deadlineMs: 9_000,
      }).pipe(Effect.forkChild);
      // A full three-second wait would run to ten seconds, past the status check's budget.
      yield* TestClock.adjust("9 seconds");
      const exit = listing.pollUnsafe();
      assert.isDefined(exit);
      assert.strictEqual(exit?._tag, "Success");
      assert.strictEqual(lists, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
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
