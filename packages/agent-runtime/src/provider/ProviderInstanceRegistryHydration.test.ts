import { expect, it } from "@effect/vitest";
import { ServerSettings, ProviderDriverKind, ProviderInstanceId } from "@nodex/runtime-contracts";
import * as Schema from "effect/Schema";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

it("starts Antigravity only for explicitly configured instances", () => {
  const decode = Schema.decodeUnknownSync(ServerSettings);
  const empty = deriveProviderInstanceConfigMap(decode({}));
  expect(Object.values(empty).some((instance) => instance.driver === "antigravity")).toBe(false);
  const configured = deriveProviderInstanceConfigMap(
    decode({
      providerInstances: {
        "google-work": {
          driver: ProviderDriverKind.make("antigravity"),
          enabled: false,
          config: {},
        },
      },
    }),
  );
  expect(configured[ProviderInstanceId.make("google-work")]).toMatchObject({
    driver: "antigravity",
    enabled: false,
  });
  expect(
    Object.values(configured).filter((instance) => instance.driver === "antigravity"),
  ).toHaveLength(1);
});
