import path from "node:path";
import { createHash } from "node:crypto";
import { expect, test } from "vite-plus/test";
import { CORE_CLIENT_REQUIREMENTS } from "@nodex/core-protocol";
import type { CoreRuntimeDescriptor } from "./types";
import { parseCoreRuntimeDescriptor } from "./runtime-descriptor";

const descriptor = (endpoint: string): CoreRuntimeDescriptor => {
  const store = CORE_CLIENT_REQUIREMENTS.accepted_store_formats[0];
  const manifest: CoreRuntimeDescriptor["manifest"] = {
    manifest_version: 1,
    transport: CORE_CLIENT_REQUIREMENTS.transport,
    event_versions: {
      min: CORE_CLIENT_REQUIREMENTS.event_version,
      max: CORE_CLIENT_REQUIREMENTS.event_version,
    },
    modules: CORE_CLIENT_REQUIREMENTS.modules.map(({ module, contract_version }) => ({
      module,
      versions: { min: contract_version, max: contract_version },
    })),
    store: { readable: [store], migratable: [], current: store },
  };
  return {
    manifest,
    manifest_digest: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    artifact: { build_id: "test", sha256: "a".repeat(64) },
    actual_store_format: store,
    pid: 123,
    start_nonce: "b".repeat(32),
    endpoint,
    profile_id: "profile",
    store_epoch: "epoch",
    readiness_generation: 1,
  };
};

test("Unix descriptors require the exact managed local socket", () => {
  const endpoint = path.resolve("profile/run/core/core.sock");
  expect(parseCoreRuntimeDescriptor(descriptor(endpoint), endpoint, "darwin").endpoint).toBe(
    endpoint,
  );
  expect(() =>
    parseCoreRuntimeDescriptor(descriptor(path.resolve("foreign.sock")), endpoint, "darwin"),
  ).toThrow("fixed runtime socket");
});

test("Windows descriptors accept only a local random Core pipe", () => {
  const endpoint = String.raw`\\.\pipe\nodex-core-${"a".repeat(32)}`;
  expect(parseCoreRuntimeDescriptor(descriptor(endpoint), "unused", "win32").endpoint).toBe(
    endpoint,
  );
  for (const invalid of [
    endpoint.replace("\\\\.\\", "\\\\remote\\"),
    endpoint.toUpperCase(),
    `${endpoint}suffix`,
    endpoint.replace("nodex-core", "nodex-clone"),
    "C:\\profile\\core.sock",
  ]) {
    expect(() => parseCoreRuntimeDescriptor(descriptor(invalid), "unused", "win32")).toThrow(
      "invalid local pipe",
    );
  }
});
