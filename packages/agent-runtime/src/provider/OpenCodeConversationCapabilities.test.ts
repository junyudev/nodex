import { assert, it } from "@effect/vitest";
import { createOpencodeClient, type Model } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerOwner from "../../vendor/provider-opencode/src/server/OpenCodeServerOwner.ts";
import {
  checkOpenCodeProviderStatus,
  makePendingOpenCodeProvider,
} from "../../vendor/provider-opencode/src/server/status.ts";

const settings = Schema.decodeSync(OpenCodeSettings)({
  enabled: true,
  customModels: ["custom/unknown"],
});
const nativeModel = (id: string, image: boolean): Model => ({
  id,
  providerID: "native",
  name: id,
  api: { id, url: "http://opencode.test", npm: "@ai-sdk/openai-compatible" },
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: image,
    toolcall: true,
    input: { text: true, image, audio: false, video: false, pdf: false },
    output: { text: true, image: false, audio: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 10_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-10-22",
});
const nativeModels = [nativeModel("vision", true), nativeModel("text-only", false)];
const inventory: OpenCodeRuntime.OpenCodeInventory = {
  providerList: {
    connected: ["native"],
    default: {},
    all: [
      {
        id: "native",
        name: "Native",
        source: "config",
        env: [],
        options: {},
        models: Object.fromEntries(nativeModels.map((model) => [model.id, model])),
      },
    ],
  },
  agents: [],
  skills: [],
};
const unused = () => Effect.die("Unexpected runtime operation during status discovery");
const runtime = OpenCodeRuntime.OpenCodeRuntime.of({
  runOpenCodeCommand: unused,
  startOpenCodeServerProcess: unused,
  connectToOpenCodeServer: unused,
  createOpenCodeSdkClient: ({ baseUrl }) => createOpencodeClient({ baseUrl }),
  loadOpenCodeInventory: () => Effect.succeed(inventory),
  loadOpenCodeSkills: unused,
  loadInventoryFromCli: unused,
  loadSkillsFromCli: unused,
});

for (const generation of ["v1", "v2"] as const) {
  const version = generation === "v1" ? "1.19.2" : "2.0.26";
  const discover = checkOpenCodeProviderStatus(
    settings,
    "/workspace",
    Effect.succeed({ generation, version }),
    Effect.succeed(
      nativeModels.map((model) => ({
        providerID: model.providerID,
        id: model.id,
        name: model.name,
        variants: [],
        capabilities: { input: model.capabilities.input.image ? ["text", "image"] : ["text"] },
      })),
    ),
  ).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
    Effect.provideService(OpenCodeServerOwner.OpenCodeServerOwner, {
      withServer: (use) =>
        use({
          url: "http://opencode.test",
          version,
          isRunning: Effect.succeed(true),
          exitCode: Effect.never,
        }),
    }),
  );

  it.effect(`offers sent-message editing after ${generation} catalog discovery`, () =>
    Effect.gen(function* () {
      const provider = yield* discover;
      assert.equal(provider.status, "ready");
      assert.isTrue(provider.supportsConversationRollback);
    }),
  );

  it.effect(`preserves ${generation} model image support and unknown custom capabilities`, () =>
    Effect.gen(function* () {
      const provider = yield* discover;
      const modalities = (slug: string) =>
        provider.models.find((model) => model.slug === slug)?.capabilities?.inputModalities;
      assert.deepEqual(modalities("native/vision"), ["text", "image"]);
      assert.deepEqual(modalities("native/text-only"), ["text"]);
      assert.isUndefined(modalities("custom/unknown"));
    }),
  );
}

it.effect("keeps OpenCode's conversation-edit capability while discovery is pending", () =>
  Effect.gen(function* () {
    const provider = yield* makePendingOpenCodeProvider(settings);
    assert.isTrue(provider.supportsConversationRollback);
  }),
);
