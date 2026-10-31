import fs from "node:fs";
import path from "node:path";
import { makePersistedAtomStore } from "../../../src/main/local-store/persisted-atoms";
import {
  updateClaudeAgentSettings,
  updateOpenCodeAgentSettings,
} from "../../../src/main/settings/application-settings-persistence";
import { agentRuntimeProviderId } from "../../../src/shared/agent-runtime-provider";
import type { ScenarioManifest } from "../contracts";
import { prepareScenarioCodexAppServerRuntimeSync } from "./agent-runtime-fixture";

export const crossProviderRuntimeRoot = (nodexHome: string): string =>
  path.join(path.dirname(nodexHome), "scripted-agent-runtime");

/** Installed only in an owned seed home, before any Electron writer opens its local stores. */
export const prepareCrossProviderDelegationRuntime = (input: {
  readonly nodexHome: string;
  readonly manifest: ScenarioManifest;
  readonly clock?: "manual" | "realtime";
}): void => {
  const root = crossProviderRuntimeRoot(input.nodexHome);
  fs.mkdirSync(path.join(root, "gates"), { recursive: true });
  const parentSession = input.manifest.entityIdsByKey?.parentSession;
  const releaseNotesSession = input.manifest.entityIdsByKey?.releaseNotesSession;
  if (!parentSession || !releaseNotesSession) throw new Error("Lumen Session identities missing");
  const claudeBinding = { kind: "claude", instanceConfigId: "lumen-claude" } as const;
  const openCodeBinding = { kind: "opencode", instanceConfigId: "lumen-opencode" } as const;
  const children = [
    {
      key: "webauthn",
      title: "WebAuthn routes",
      durationMs: 12_000,
      task: "Add WebAuthn registration and assertion routes under app/api/auth/webauthn, with a challenge store that expires after five minutes. Leave password sign-in untouched.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        options: { reasoningEffort: "xhigh" },
      },
      file: "app/api/auth/webauthn/README.md",
      summary:
        "Added WebAuthn registration and assertion routes with five-minute challenges. Password sign-in is unchanged.",
    },
    {
      key: "credentials",
      title: "Credentials migration",
      durationMs: 6_000,
      task: "Add a credentials table for passkeys and backfill a row for every existing account, in one reversible migration.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        options: { reasoningEffort: "high" },
      },
      file: "migrations/passkey-credentials.md",
      summary: "Added a reversible credentials migration with an account backfill.",
    },
    {
      key: "docs",
      title: "Passkey docs",
      durationMs: 20_000,
      task: "Document passkey sign-in for users and admins, and when the password fallback goes away.",
      target: {
        providerInstanceId: agentRuntimeProviderId(openCodeBinding),
        model: "opencode/glm-5.3-flash-free",
      },
      file: "docs/passkeys.md",
      summary:
        "Documented passkey setup, recovery, and the password fallback rollout for users and admins.",
    },
    {
      key: "tests",
      title: "Sign-in tests",
      durationMs: 8_000,
      task: "Add sign-in tests for passkey registration, assertion, challenge expiry, and password fallback.",
      target: {
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        options: { reasoningEffort: "high" },
      },
      file: "tests/passkey-plan.md",
      summary:
        "Sign-in tests failed: the fixture browser does not expose a WebAuthn authenticator.",
      fail: true,
    },
  ];
  fs.writeFileSync(
    path.join(root, "plan.json"),
    JSON.stringify(
      {
        scenario: "passkeys",
        clock: input.clock ?? "realtime",
        children,
        parentSession,
        releaseNotesSession,
        manifest: input.manifest,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, "scenario-manifest.json"),
    JSON.stringify(input.manifest, null, 2),
  );
  const sourceDirectory = path.resolve("scripts/scenarios/runtime");
  for (const [name, source] of [
    ["claude", "cross-provider-peer.mjs"],
    ["codex", "cross-provider-peer.mjs"],
    ["opencode", "scripted-opencode-agent.mjs"],
  ]) {
    const body = fs
      .readFileSync(path.join(sourceDirectory, source), "utf8")
      .replace(/^#![^\n]*\n/u, "");
    fs.writeFileSync(
      path.join(root, name),
      `#!${process.execPath}\nprocess.env.NODEX_TEST_CROSS_PROVIDER_HOME = ${JSON.stringify(root)};\n${body}`,
      { mode: 0o755 },
    );
  }
  prepareScenarioCodexAppServerRuntimeSync(root, path.join(root, "codex"));
  const settings = { settingsPath: path.join(input.nodexHome, "config.toml"), environment: {} };
  updateClaudeAgentSettings(
    {
      instances: [
        {
          id: claudeBinding.instanceConfigId,
          displayName: "Claude Code",
          enabled: true,
          binaryPath: path.join(root, "claude"),
          configDirectory: path.join(root, "claude-home"),
          customModels: [],
          environment: [],
        },
      ],
    },
    settings,
  );
  updateOpenCodeAgentSettings(
    {
      instances: [
        {
          id: openCodeBinding.instanceConfigId,
          displayName: "OpenCode",
          enabled: true,
          binaryPath: path.join(root, "opencode"),
          profileDirectory: path.join(root, "opencode-home"),
          serverUrl: null,
          environment: [],
        },
      ],
    },
    settings,
  );
  const atoms = makePersistedAtomStore(input.nodexHome);
  atoms.update({
    key: "agent-runtime-composer-choices-v1",
    value: {
      [JSON.stringify([parentSession, input.manifest.projectId])]: {
        selection: {
          binding: claudeBinding,
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        },
      },
      [JSON.stringify([releaseNotesSession, input.manifest.projectId])]: {
        selection: {
          binding: { kind: "codex" },
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    },
  });
};
