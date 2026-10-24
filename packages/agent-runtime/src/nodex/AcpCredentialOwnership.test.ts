import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { acpRegistryCredentialBinding } from "../../vendor/provider-acp-registry/src/server/auth.ts";

import { providerCredentialBindingsOverlap } from "@t3tools/provider-core/server/auth";

const settings = Schema.decodeSync(AcpRegistrySettings)({ source: "local", commandPath: "agent" });

it("coordinates Windows shells that share USERPROFILE despite different shell homes", () => {
  const first = acpRegistryCredentialBinding(
    settings,
    { USERPROFILE: "C:\\Users\\shared", HOME: "C:\\shell-a" },
    "C:\\agent.exe",
    "win32",
  );
  const second = acpRegistryCredentialBinding(
    settings,
    { USERPROFILE: "C:\\Users\\shared", HOME: "C:\\shell-b", CARGO_HOME: "C:\\cargo" },
    "C:\\agent.exe",
    "win32",
  );
  const isolated = acpRegistryCredentialBinding(
    settings,
    { USERPROFILE: "C:\\Users\\isolated", HOME: "C:\\shell-a" },
    "C:\\agent.exe",
    "win32",
  );
  expect(providerCredentialBindingsOverlap(first, second)).toBe(true);
  expect(providerCredentialBindingsOverlap(first, isolated)).toBe(false);
});

it("uses the POSIX home unless Main provides an authoritative credential root", () => {
  const first = acpRegistryCredentialBinding(
    settings,
    { HOME: "/shared", USERPROFILE: "/shell-a" },
    "/agent",
    "linux",
  );
  const second = acpRegistryCredentialBinding(
    settings,
    { HOME: "/shared", USERPROFILE: "/shell-b" },
    "/agent",
    "linux",
  );
  const sharedRoot = { ...settings, credentialStorageScopes: ["/credentials"] };
  expect(providerCredentialBindingsOverlap(first, second)).toBe(true);
  expect(
    providerCredentialBindingsOverlap(
      acpRegistryCredentialBinding(sharedRoot, { HOME: "/first" }, "/agent", "linux"),
      acpRegistryCredentialBinding(sharedRoot, { HOME: "/second" }, "/agent", "linux"),
    ),
  ).toBe(true);
});

it("coordinates intersecting claims across different binding identities without merging isolated profiles", () => {
  const bind = (scopes: string[], agentIdentity: string) =>
    acpRegistryCredentialBinding(
      { ...settings, agentIdentity, credentialStorageScopes: scopes },
      {},
      "/agent",
      "linux",
    );
  const unknown = bind(["/home"], "opaque");
  const known = bind(["/home", "/home/.claude"], "claude-agent-acp");
  const sharedStore = bind(["/other", "/home/.claude"], "claude-agent-acp");
  const isolated = bind(["/home/isolated", "/home/isolated/.claude"], "claude-agent-acp");
  expect(unknown.claims).not.toEqual(known.claims);
  expect(providerCredentialBindingsOverlap(unknown, known)).toBe(true);
  expect(providerCredentialBindingsOverlap(known, sharedStore)).toBe(true);
  expect(providerCredentialBindingsOverlap(unknown, isolated)).toBe(false);
  expect(providerCredentialBindingsOverlap(known, isolated)).toBe(false);
});

it("keeps standalone credential claims nonempty and rejects empty projected scopes", () => {
  const first = acpRegistryCredentialBinding(settings, {}, "/agent", "linux");
  const second = acpRegistryCredentialBinding(settings, {}, "/agent", "linux");
  expect(first.claims).toHaveLength(1);
  expect(providerCredentialBindingsOverlap(first, second)).toBe(true);
  expect(() =>
    Schema.decodeSync(AcpRegistrySettings)({
      source: "local",
      commandPath: "agent",
      credentialStorageScopes: [],
    }),
  ).toThrow();
});
