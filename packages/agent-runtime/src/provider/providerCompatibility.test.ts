import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@nodex/runtime-contracts";
import { BUNDLED_MODEL_MANIFEST } from "./ModelManifest.ts";
import { brokenRuntimeError, resolveProviderCompatibility } from "./providerCompatibility.ts";

const driver = ProviderDriverKind.make("antigravity");
const policies = BUNDLED_MODEL_MANIFEST.compatibility;

describe("Antigravity runtime compatibility", () => {
  it("refuses unsupported protocol generations regardless of native release prefix", () => {
    for (const version of [
      "1.1.1",
      "1.3.0",
      "1.4.1",
      "1.4.5",
      "1.4.9",
      "agy_acp_server_1.4.5",
      "1.4.5-beta",
    ]) {
      assert.strictEqual(
        resolveProviderCompatibility(policies, driver, version)?.status,
        "broken",
        version,
      );
    }
    const supported = resolveProviderCompatibility(policies, driver, "1.5.11");
    assert.strictEqual(supported?.status, "supported");
    assert.strictEqual(supported?.recommendedRange, ">=1.5.12 <2");
  });

  it("keeps an unknown version open and returns one actionable error for a broken runtime", () => {
    const instanceId = ProviderInstanceId.make("google-work");
    assert.isUndefined(
      brokenRuntimeError({
        instanceId,
        name: "Antigravity",
        version: "custom",
        advisory: resolveProviderCompatibility(policies, driver, "custom"),
      }),
    );
    const error = brokenRuntimeError({
      instanceId,
      name: "Antigravity",
      version: "1.4.5",
      advisory: resolveProviderCompatibility(policies, driver, "1.4.5"),
      action: "Update it in provider setup",
    });
    assert.strictEqual(error?.operation, "runtime");
    assert.strictEqual(error?.instanceId, instanceId);
    assert.strictEqual(
      error?.detail,
      "Antigravity 1.4.5 does not work with this Nodex release. Update it in provider setup to >=1.5.12 <2, then retry.",
    );
  });
});
