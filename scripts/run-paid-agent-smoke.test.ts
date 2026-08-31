import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { parse as parseToml } from "smol-toml";

import { applyCodexFeatureDefaults } from "../src/main/codex/codex-feature-defaults";
import {
  buildPaidAgentSmokeCodexConfig,
  isPaidChatGptPlan,
  PAID_AGENT_SMOKE_DEFINITIONS,
} from "./paid-agent-smoke-contract";
import {
  formatPaidAgentSmokeBanner,
  resolvePaidAgentSmokeInvocation,
} from "./run-paid-agent-smoke";

const roots: string[] = [];

const authenticatedHome = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ndx-paid-runner-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "codex"));
  fs.writeFileSync(path.join(root, "codex", "auth.json"), "{}\n");
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Paid Agent smoke runner", () => {
  test("requires one explicit, bounded case", () => {
    const root = authenticatedHome();
    const input = { cwd: root, codexHome: path.join(root, "codex") };

    expect(() => resolvePaidAgentSmokeInvocation([], input)).toThrow("requires exactly one case");
    expect(() => resolvePaidAgentSmokeInvocation(["--case", "file", "--workers=2"], input)).toThrow(
      "requires exactly one case",
    );
    expect(() => resolvePaidAgentSmokeInvocation(["--", "--case", "file"], input)).toThrow(
      "Do not pass a standalone `--`",
    );
    expect(() => resolvePaidAgentSmokeInvocation(["--case", "unknown"], input)).toThrow(
      "file | browser | subagent",
    );
  });

  test("resolves an authenticated case and deterministic artifact root", () => {
    const root = authenticatedHome();
    const invocation = resolvePaidAgentSmokeInvocation(["--case", "subagent"], {
      cwd: root,
      codexHome: path.join(root, "codex"),
      now: new Date("2026-09-01T12:34:56.789Z"),
    });
    expect(invocation).toEqual({
      caseId: "subagent",
      sourceAuthPath: path.join(root, "codex", "auth.json"),
      sourceCodexHome: path.join(root, "codex"),
      artifactRoot: path.join(root, "runs.local/paid-agent-smoke/20260901T123456789Z-subagent"),
    });
    expect(formatPaidAgentSmokeBanner(invocation)).toContain(
      `Authentication source: ${path.join(root, "codex", "auth.json")}`,
    );
    expect(PAID_AGENT_SMOKE_DEFINITIONS.subagent).toMatchObject({
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      expectedLogicalExecutions: 2,
    });
  });

  test("fails before any build when authentication is unavailable", () => {
    const root = authenticatedHome();
    fs.rmSync(path.join(root, "codex", "auth.json"));
    expect(() =>
      resolvePaidAgentSmokeInvocation(["--case", "file"], {
        cwd: root,
        codexHome: path.join(root, "codex"),
      }),
    ).toThrow("requires Codex authentication");
  });

  test("distinguishes subscription-backed ChatGPT plans from free or unknown accounts", () => {
    expect(isPaidChatGptPlan("plus")).toBe(true);
    expect(isPaidChatGptPlan("enterprise")).toBe(true);
    expect(isPaidChatGptPlan("free")).toBe(false);
    expect(isPaidChatGptPlan("unknown")).toBe(false);
    expect(isPaidChatGptPlan("future-unreviewed-plan")).toBe(false);
  });

  test("disables collaboration overrides for non-subagent canaries", () => {
    const fileConfig = applyCodexFeatureDefaults(
      parseToml(buildPaidAgentSmokeCodexConfig("file"), { integersAsBigInt: true }),
    ).config;
    const browserConfig = applyCodexFeatureDefaults(
      parseToml(buildPaidAgentSmokeCodexConfig("browser"), { integersAsBigInt: true }),
    ).config;
    const subagentConfig = applyCodexFeatureDefaults(
      parseToml(buildPaidAgentSmokeCodexConfig("subagent"), { integersAsBigInt: true }),
    ).config;

    expect(fileConfig.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(browserConfig.features).toMatchObject({ multi_agent: false, multi_agent_v2: false });
    expect(fileConfig.agents).toEqual({ enabled: false });
    expect(browserConfig.agents).toEqual({ enabled: false });
    expect(subagentConfig).not.toHaveProperty("agents");
    expect(subagentConfig.features).toMatchObject({ multi_agent: true });
    expect(subagentConfig.features).not.toHaveProperty("multi_agent_v2");
  });

  test("accepts a symlinked authentication source with a regular target", () => {
    const root = authenticatedHome();
    const authPath = path.join(root, "codex", "auth.json");
    const credentialPath = path.join(root, "credential.json");
    fs.renameSync(authPath, credentialPath);
    fs.symlinkSync(credentialPath, authPath);

    expect(
      resolvePaidAgentSmokeInvocation(["--case", "file"], {
        cwd: root,
        codexHome: path.join(root, "codex"),
      }),
    ).toMatchObject({ sourceAuthPath: authPath });
  });
});
