import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { acpRegistryCredentialBindingKey } from "../../vendor/provider-acp-registry/src/server/auth.ts";

const settings = Schema.decodeSync(AcpRegistrySettings)({ source: "local", commandPath: "agent" });

it("coordinates Windows shells that share USERPROFILE despite different shell homes", () => {
  const first = acpRegistryCredentialBindingKey(
    settings,
    { USERPROFILE: "C:\\Users\\shared", HOME: "C:\\shell-a" },
    "C:\\agent.exe",
    "win32",
  );
  const second = acpRegistryCredentialBindingKey(
    settings,
    { USERPROFILE: "C:\\Users\\shared", HOME: "C:\\shell-b", CARGO_HOME: "C:\\cargo" },
    "C:\\agent.exe",
    "win32",
  );
  const isolated = acpRegistryCredentialBindingKey(
    settings,
    { USERPROFILE: "C:\\Users\\isolated", HOME: "C:\\shell-a" },
    "C:\\agent.exe",
    "win32",
  );
  expect(first).toBe(second);
  expect(first).not.toBe(isolated);
});

it("uses the POSIX home unless Main provides an authoritative credential root", () => {
  const first = acpRegistryCredentialBindingKey(
    settings,
    { HOME: "/shared", USERPROFILE: "/shell-a" },
    "/agent",
    "linux",
  );
  const second = acpRegistryCredentialBindingKey(
    settings,
    { HOME: "/shared", USERPROFILE: "/shell-b" },
    "/agent",
    "linux",
  );
  const sharedRoot = { ...settings, credentialStorageScope: "/credentials" };
  expect(first).toBe(second);
  expect(acpRegistryCredentialBindingKey(sharedRoot, { HOME: "/first" }, "/agent", "linux")).toBe(
    acpRegistryCredentialBindingKey(sharedRoot, { HOME: "/second" }, "/agent", "linux"),
  );
});
