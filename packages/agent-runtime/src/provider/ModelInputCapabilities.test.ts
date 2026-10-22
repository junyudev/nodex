import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  createModelCapabilities,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { acpRegistryProbeResult } from "../../vendor/provider-acp-registry/src/server/probe.ts";
import {
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
} from "../../vendor/provider-acp-registry/src/server/driver.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AcpRegistryRuntimeCoordinator from "../../vendor/provider-acp-registry/src/server/AcpRegistryRuntimeCoordinator.ts";
import { mapCodexModelCapabilities } from "./CodexProvider.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const codexModel = {
  id: "test",
  model: "test",
  displayName: "Test",
  description: "Test",
  hidden: false,
  isDefault: true,
  defaultReasoningEffort: "medium",
  supportedReasoningEfforts: [],
  additionalSpeedTiers: [],
} as const;

describe("model input capability authority", () => {
  it.each([
    { name: "unknown", inputModalities: undefined },
    { name: "no advertised input", inputModalities: [] },
    { name: "text-only", inputModalities: ["text"] },
    { name: "vision", inputModalities: ["text", "image"] },
  ] as const)("preserves Codex model/list modalities: $name", ({ inputModalities }) => {
    expect(
      mapCodexModelCapabilities({
        ...codexModel,
        ...(inputModalities ? { inputModalities } : {}),
      }).inputModalities,
    ).toEqual(inputModalities);
  });

  it("round-trips custom model capability declarations without fabricating unknown capabilities", () => {
    const capabilities = createModelCapabilities({
      optionDescriptors: [],
      inputModalities: ["text"],
    });
    const declared = { slug: "custom", capabilities };
    const entry = readCustomModelEntries([declared])[0]!;
    expect(entry.capabilities?.inputModalities).toEqual(["text"]);
    expect(toCustomModelSetting(entry)).toEqual(declared);
    expect(readCustomModelEntries(["opaque"])[0]!.capabilities).toBeNull();
  });

  it("lets a fresh text-only catalog replace cached vision even when option metadata is absent", () => {
    const previous: ServerProvider = {
      instanceId: ProviderInstanceId.make("test"),
      driver: ProviderDriverKind.make("opencode"),
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-22T00:00:00.000Z",
      slashCommands: [],
      skills: [],
      models: [
        {
          slug: "model",
          name: "Model",
          isCustom: false,
          capabilities: {
            inputModalities: ["text", "image"],
            optionDescriptors: [{ id: "mode", label: "Mode", type: "boolean" }],
          },
        },
      ],
    };
    const next = {
      ...previous,
      models: [{ ...previous.models[0]!, capabilities: { inputModalities: ["text"] as const } }],
    };
    const result = mergeProviderSnapshot(previous, next);
    expect(result.models[0]!.capabilities?.inputModalities).toEqual(["text"]);
    expect(result.models[0]!.capabilities?.optionDescriptors).toEqual(
      previous.models[0]!.capabilities?.optionDescriptors,
    );
    const removedCustomDeclaration = mergeProviderSnapshot(
      { ...previous, models: [{ ...previous.models[0]!, isCustom: true }] },
      { ...previous, models: [{ ...previous.models[0]!, isCustom: true, capabilities: null }] },
    );
    expect(removedCustomDeclaration.models[0]!.capabilities?.inputModalities).toBeUndefined();
  });
});

describe("ACP negotiated image support", () => {
  const instanceId = ProviderInstanceId.make("acp-images");
  const snapshot = (image: boolean | undefined) => {
    const probe = acpRegistryProbeResult(instanceId, {
      sessionId: "probe",
      modelConfigId: undefined,
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: { promptCapabilities: image === undefined ? {} : { image } },
      },
      sessionSetupResult: { sessionId: "probe" },
    });
    return buildCheckedAcpRegistrySnapshot({
      instanceId,
      displayName: "ACP",
      accentColor: undefined,
      continuationKey: "acp-images",
      settings: Schema.decodeUnknownSync(AcpRegistrySettings)({ agentId: "test" }),
      checkedAt: "2026-10-22T00:00:00.000Z",
      inspection: { status: "ready", agentId: "test", version: "1", distribution: "npx" },
      probe: { probe, slashCommands: [], skills: [] },
    });
  };

  it.each([true, false, undefined])(
    "projects completed initialize image=%j into the catalog",
    (image) => {
      expect(snapshot(image).models[0]!.capabilities?.inputModalities).toEqual(
        image ? ["text", "image"] : ["text"],
      );
    },
  );

  it("preserves negotiated support through an option-only update and replaces it on a new handshake", () => {
    const configuration = {
      models: [{ id: "live", name: "Live", description: null }],
      currentModelId: "live",
      configOptions: [],
    };
    const updated = applyAcpRegistryLiveConfiguration(snapshot(true), configuration, []);
    expect(updated.models[0]!.capabilities?.inputModalities).toEqual(["text", "image"]);
    const textOnly = applyAcpRegistryLiveConfiguration(
      updated,
      { ...configuration, inputModalities: ["text"] },
      [],
    );
    expect(textOnly.models[0]!.capabilities?.inputModalities).toEqual(["text"]);
  });

  it.effect(
    "retains live negotiation through configuration updates and clears it with the instance",
    () =>
      Effect.gen(function* () {
        const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
        const configuration = { models: [], currentModelId: null, configOptions: [] };
        yield* coordinator.publishLiveConfiguration(instanceId, {
          ...configuration,
          inputModalities: ["text", "image"],
        });
        yield* coordinator.publishLiveConfiguration(instanceId, configuration);
        expect(
          Option.getOrThrow(yield* coordinator.getLiveConfiguration(instanceId)).inputModalities,
        ).toEqual(["text", "image"]);
        yield* coordinator.publishLiveConfiguration(instanceId, {
          ...configuration,
          inputModalities: ["text"],
        });
        expect(
          Option.getOrThrow(yield* coordinator.getLiveConfiguration(instanceId)).inputModalities,
        ).toEqual(["text"]);
        yield* coordinator.clearLiveConfiguration(instanceId);
        yield* coordinator.publishLiveConfiguration(instanceId, configuration);
        expect(
          Option.getOrThrow(yield* coordinator.getLiveConfiguration(instanceId)).inputModalities,
        ).toBeUndefined();
      }).pipe(Effect.provide(AcpRegistryRuntimeCoordinator.layer), Effect.scoped),
  );
});
