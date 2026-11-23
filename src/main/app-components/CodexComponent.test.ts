import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect, test } from "vite-plus/test";
import { externalCodexPackage } from "../codex/CodexPackage";
import { matchesPinnedCodexAppServerIdentity } from "../codex/codex-runtime";
import type { AppComponentState } from "../../shared/app-components";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import type { AppComponents } from "./AppComponents";
import {
  admitCodexPackage,
  codexComponentAvailability,
  codexComponentUnavailableReason,
  hasCodexCreditModels,
  hasCodexSession,
  needsCodexComponentForAccounts,
} from "./CodexComponent";

test("counts recognized OpenAI credit models and existing Codex Sessions as demand", () => {
  expect(hasCodexCreditModels([{ id: "gpt-6-luna", protocol: "openai" }])).toBe(true);
  expect(
    hasCodexCreditModels([
      { id: "claude-opus-5-5", protocol: "anthropic" },
      { id: "unknown", protocol: "openai" },
    ]),
  ).toBe(false);
  type Task = Extract<
    ProjectWorkspaceReadSnapshot["value"],
    { kind: "session_window" }
  >["sessions"]["items"][number]["task"];
  const task = (kind: string) =>
    ({
      thread: {
        backend_binding: { driver: kind === "claude" ? "claudeAgent" : kind, instanceId: kind },
      },
    }) as Pick<Task, "thread">;
  expect(hasCodexSession([task("claude"), task("codex")])).toBe(true);
  expect(hasCodexSession([task("claude")])).toBe(false);
});

it.effect("passive admission waits for wanted Codex only and preserves the turned-off reason", () =>
  Effect.gen(function* () {
    const missing = {
      status: "unavailable",
      reason: "not-installed",
      message: "Codex is not installed.",
    } as const;
    const dormant: AppComponentState = {
      id: "codex",
      enabled: true,
      downloadBytes: 123,
      installation: { status: "on-demand" },
      removalPending: false,
    };
    expect(codexComponentUnavailableReason(undefined, missing)).toBeUndefined();
    expect(codexComponentUnavailableReason(dormant, missing)).toBe("not-installed");
    expect(codexComponentUnavailableReason({ ...dormant, enabled: false }, missing)).toBe(
      "turned-off",
    );
    let component = dormant;
    let ensured = 0;
    const owner = {
      read: Effect.sync(() => ({ revision: 1, components: [component] })),
      ensure: () =>
        Effect.sync(() => {
          ensured += 1;
          return { status: "unavailable", reason: "turned-off", message: "" } as const;
        }),
    } satisfies Pick<AppComponents["Service"], "read" | "ensure">;
    const admit = Effect.result(admitCodexPackage(owner, Effect.succeed(missing)));
    expect(yield* admit).toMatchObject({ failure: { availabilityReason: "not-installed" } });
    expect(ensured).toBe(0);
    component = { ...dormant, installation: { status: "queued" } };
    expect(codexComponentUnavailableReason(component, missing)).toBe("installing");
    expect(yield* admit).toMatchObject({
      failure: {
        availabilityReason: "turned-off",
        message: "Codex is turned off in Settings → General → Add-ons.",
      },
    });
    expect(ensured).toBe(1);
  }),
);

it.effect(
  "an external Codex bypasses Component admission and carries no Desktop Tools identity",
  () =>
    Effect.gen(function* () {
      const runtime = externalCodexPackage({
        status: "ready",
        version: "0.167.2",
        binaryPath: "/external/bin/codex",
      });
      const off: AppComponentState = {
        id: "codex",
        enabled: false,
        downloadBytes: 123,
        installation: { status: "not-installed" },
        removalPending: false,
      };
      const unavailable = externalCodexPackage({ status: "not-found" });
      expect(codexComponentUnavailableReason(off, unavailable)).toBeUndefined();
      expect(codexComponentUnavailableReason(off, runtime)).toBeUndefined();
      expect(codexComponentAvailability(off, unavailable)).toMatchObject({
        status: "unavailable",
        reason: "external-unusable",
        message: "The Codex executable was not found.",
      });
      const owner = {
        read: Effect.succeed({ revision: 1, components: [off] }),
        ensure: () => Effect.die("External Codex tried to install the Component"),
      };
      const admitted = yield* admitCodexPackage(owner, Effect.succeed(runtime));
      expect(admitted).toMatchObject({
        source: "external",
        binaryPath: "/external/bin/codex",
        version: "0.167.2",
      });
      expect(
        matchesPinnedCodexAppServerIdentity(admitted.appServerIdentity, "darwin", "arm64"),
      ).toBe(false);
    }),
);

test("a configured Codex executable leaves credit-backed Component demand active", () => {
  const external = { usesExternalExecutable: true, accountPresent: true, creditModels: [] };
  expect(needsCodexComponentForAccounts(external)).toBe(false);
  expect(
    needsCodexComponentForAccounts({
      ...external,
      creditModels: [{ id: "gpt-6-luna", protocol: "openai" }],
    }),
  ).toBe(true);
  expect(needsCodexComponentForAccounts({ ...external, usesExternalExecutable: false })).toBe(true);
});
