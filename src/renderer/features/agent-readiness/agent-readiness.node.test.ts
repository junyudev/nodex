import { describe, expect, it } from "vite-plus/test";
import { agentDefinition } from "../../../shared/agents/registry";
import {
  agentReadiness,
  agentSignInOffer,
  type AgentReadinessProvider,
} from "../../../shared/agents/readiness";
import type { AppComponentInstallation, AppComponentState } from "../../../shared/app-components";
import { componentInstallationReadiness } from "../app-components/provider-component-setup";
import { agentReadinessView } from "@/lib/agent-readiness-view";

const snapshot = (patch: Partial<AgentReadinessProvider> = {}): AgentReadinessProvider => ({
  driver: "future-agent",
  instanceId: "work",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-01T00:00:00.000Z",
  models: [{ slug: "m", name: "Model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...patch,
});
const definition = {
  driver: "future-agent",
  label: "Future Agent",
  profileBased: true,
  setup: { signIn: { via: "settings" }, models: "choose" },
  capabilities: {},
} as const;

describe("Agent readiness from a provider check", () => {
  it("keeps an unverified sign-in from holding the send", () => {
    expect(agentReadiness({ definition, provider: snapshot(), model: "m" })).toBeNull();
    expect(
      agentReadiness({
        definition,
        provider: snapshot({ installed: false, checkPending: true, models: [] }),
        model: "m",
      }),
    ).toMatchObject({ problem: { kind: "checking" }, action: null, blocksSend: false });
  });

  it.each([
    [{ enabled: false }, "turned-off", "settings"],
    [{ installed: false, status: "error" }, "not-installed", "settings"],
    [{ auth: { status: "unauthenticated" } }, "signed-out", "sign-in"],
    [{ status: "error", issue: "account-unavailable" }, "no-connection", "check-again"],
    [{ status: "error", issue: "unresponsive" }, "not-responding", "check-again"],
    [{ status: "error", message: "exited with code 2" }, "could-not-start", "check-again"],
    [
      { availability: "unavailable", unavailableReason: "Removed" },
      "could-not-start",
      "check-again",
    ],
  ] as const)("maps %j to %s", (patch, kind, action) => {
    expect(agentReadiness({ definition, provider: snapshot(patch), model: "m" })).toMatchObject({
      problem: { kind },
      action: { kind: action },
      blocksSend: true,
    });
  });

  it.each([
    ["", ["m"], "choose-model"],
    ["removed", ["m"], "model-missing"],
    ["m", [], "no-models"],
  ] as const)("matches the selected model %s against %j", (model, slugs, kind) => {
    const provider = snapshot({
      auth: { status: "authenticated" },
      models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    });
    expect(agentReadiness({ definition, provider, model })).toMatchObject({
      problem: { kind },
      blocksSend: true,
    });
  });

  it("offers sign-in for an account that never answered, and only then", () => {
    const unchecked = snapshot({ models: [] });
    // Nothing is wrong, so nothing holds a send; the offer is what makes the Agent reachable.
    expect(agentReadiness({ definition, provider: unchecked })).toBeNull();
    expect(agentSignInOffer(definition, unchecked)).toEqual({ kind: "sign-in", via: "settings" });
    for (const provider of [
      snapshot(),
      snapshot({ models: [], auth: { status: "authenticated" } }),
      snapshot({ models: [], auth: { status: "unauthenticated" } }),
      snapshot({ models: [], enabled: false }),
      snapshot({ models: [], installed: false }),
    ])
      expect(agentSignInOffer(definition, provider)).toBeNull();
    // An Agent whose models are discovered rather than chosen has its own connect step.
    expect(
      agentSignInOffer(
        { ...definition, setup: { ...definition.setup, models: "discover" } },
        unchecked,
      ),
    ).toBeNull();
  });

  it("keeps readiness detail and the Agent label where the person can use them", () => {
    const provider = snapshot({ status: "error", message: "exited with code 2" });
    const readiness = agentReadiness({ definition, provider })!;
    expect(agentReadinessView(definition.label, readiness)).toMatchObject({
      title: "Couldn’t start Future Agent",
      detail: "exited with code 2",
      tone: "danger",
    });
  });

  it("uses the same auth fact for browser, terminal and in-app sign-in", () => {
    for (const [driver, via] of [
      ["codex", "browser"],
      ["claudeAgent", "terminal"],
      ["acpRegistry", "dialog"],
    ]) {
      expect(
        agentReadiness({
          definition: agentDefinition(driver),
          provider: snapshot({ driver, auth: { status: "unauthenticated" } }),
        })?.action,
      ).toMatchObject({ kind: "sign-in", via });
    }
  });

  it.each(["unknown", "failed", "ready"] as const)(
    "handles %s discovery after installation",
    (status) => {
      const readiness = agentReadiness({
        definition: agentDefinition("acpRegistry"),
        provider: snapshot({ discovery: { status, checkedAt: "2026-10-01T00:00:00.000Z" } }),
      });
      if (status === "ready") expect(readiness).toBeNull();
      else
        expect(readiness).toMatchObject({
          problem: { kind: status === "failed" ? "connection-failed" : "not-connected" },
          action: { kind: "connect" },
          blocksSend: false,
        });
    },
  );

  it("names the version required to use a model", () => {
    const provider = snapshot({
      updateRequiredModels: [{ slug: "new", name: "New", minVersion: "2.4.0" }],
    });
    expect(agentReadiness({ definition, provider, model: "new" })).toMatchObject({
      problem: { kind: "needs-update", version: "2.4.0" },
      action: { kind: "settings" },
    });
  });
});

describe("Agent readiness from an installation source", () => {
  const source = { kind: "component", id: "future-component" } as const;
  const provider = snapshot({ installed: false, installationSource: source });
  const component = (
    installation: AppComponentInstallation,
    enabled = true,
  ): AppComponentState => ({
    id: "codex",
    enabled,
    installation,
    removalPending: false,
    downloadBytes: 100,
  });

  it("uses the component id as an opaque target and carries download progress", () => {
    const installation = componentInstallationReadiness(
      component({ status: "downloading", receivedBytes: 35, totalBytes: 100 }),
      false,
    );
    const readiness = agentReadiness({ definition, provider, installation });
    expect(readiness).toMatchObject({
      problem: { kind: "installing", progress: 0.35 },
      action: null,
      blocksSend: true,
      found: false,
    });
    expect(agentReadinessView(definition.label, readiness!).title).toBe(
      "Installing Future Agent… 35%",
    );
  });

  it.each([null, 9_000])("distinguishes a failed download with retry time %s", (retryAt) => {
    const installation = componentInstallationReadiness(
      component({
        status: "failed",
        reason: "integrity",
        message: "Invalid archive",
        retryAt,
      }),
      false,
    );
    const readiness = agentReadiness({ definition, provider, installation });
    expect(readiness).toMatchObject({
      problem: { kind: "installation-failed", retry: retryAt ? "automatic" : "manual" },
      action: retryAt ? null : { kind: "retry-installation", sourceId: source.id },
      blocksSend: true,
    });
  });

  it("keeps dormant Components selectable and routes a supplier's off state to Components", () => {
    const onDemand = componentInstallationReadiness(component({ status: "on-demand" }), false);
    expect(
      agentReadiness({
        definition: agentDefinition("codex"),
        provider,
        installation: onDemand,
      }),
    ).toMatchObject({ problem: { kind: "not-installed", onDemand: true }, blocksSend: false });
    const off = componentInstallationReadiness(
      component({ status: "not-installed" }, false),
      false,
    );
    expect(agentReadiness({ definition, provider, installation: off })).toMatchObject({
      problem: { kind: "turned-off", supplier: true },
      action: { kind: "components" },
    });
  });

  it("routes an installation to its runtime owner while preserving an external executable", () => {
    const managed = { kind: "managed", id: "runtime" } as const;
    expect(
      agentReadiness({
        definition,
        source: managed,
        installation: { problem: { kind: "not-installed" } },
      })?.action,
    ).toEqual({ kind: "install", sourceId: "runtime" });
    expect(
      agentReadiness({
        definition,
        provider: snapshot({ installationSource: { kind: "external" } }),
      }),
    ).toBeNull();
  });
});
