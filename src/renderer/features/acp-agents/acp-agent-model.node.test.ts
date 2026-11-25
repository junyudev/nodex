import { describe, expect, test } from "vite-plus/test";
import {
  acpInstanceInput,
  acpAgentsSummary,
  acpCommandLine,
  acpFailureCopy,
  acpImportedHistoryEmptyState,
  acpPendingImportedHistory,
  acpInstanceName,
  acpInstanceStatus,
  acpProgressText,
  acpRegistryUnavailableText,
  acpSignInMethods,
  acpUpdateVersion,
  splitPastedAcpArguments,
  type AcpActivity,
  type AcpInstanceStatus,
} from "./acp-agent-model";
import {
  acpAgentDraft,
  acpArgumentProblem,
  acpDraftChanged,
  acpDraftInput,
  acpDraftProblem,
} from "./acp-agent-draft";
import { ACP_ARGUMENT_MAX_LENGTH } from "../../../shared/acp-agent-settings";
import {
  localInstance,
  registryInstance,
  discovered,
  providerSnapshot,
  readyInspection,
  registryAgent,
} from "./acp-agents.test-fixtures";
import { authTerminalDelta } from "../agent-account/auth-terminal-output";

describe("ACP instance drafts", () => {
  test("an unedited draft keeps empty and multi-line arguments exactly", () => {
    const instance = localInstance({
      source: {
        kind: "local",
        executable: "/opt/agents/scripted",
        args: ["--message", "", "first line\nsecond line", "  padded  "],
      },
      environment: [{ name: "TOKEN", sensitive: true, value: null }],
    });
    const draft = acpAgentDraft(instance);
    expect(acpDraftChanged(instance, draft)).toBe(false);

    const renamed = acpDraftInput(acpInstanceInput(instance), { ...draft, displayName: "Renamed" });
    expect(renamed.source).toEqual(instance.source);
    expect(renamed.environment).toEqual([{ name: "TOKEN", sensitive: true, value: null }]);
    expect(renamed.displayName).toBe("Renamed");
  });

  test("a draft applies to the instance as saved, keeping an installation pinned meanwhile", () => {
    const opened = registryInstance();
    const draft = { ...acpAgentDraft(opened), displayName: "Qoder work" };
    const savedSince = acpInstanceInput(
      registryInstance({
        source: {
          kind: "registry",
          agentId: "qoder-cli",
          distribution: "auto",
          installationId: "e".repeat(64),
        },
      }),
    );
    expect(acpDraftInput(savedSince, draft).source).toEqual(savedSince.source);
    // Another distribution belongs to another installation, so the pin is released.
    expect(acpDraftInput(savedSince, { ...draft, distribution: "npx" }).source).toEqual({
      kind: "registry",
      agentId: "qoder-cli",
      distribution: "npx",
    });
  });

  test("an argument a command can't receive blocks Save at that argument", () => {
    const longest = "a".repeat(ACP_ARGUMENT_MAX_LENGTH);
    expect(acpArgumentProblem(["--acp", "", longest, "line one\nline two"])).toBeNull();
    expect(acpArgumentProblem(["--acp", `${longest}a`])).toEqual({
      index: 1,
      message: "Argument 2 is longer than the 32,768-character limit.",
    });
    expect(acpArgumentProblem(["a\0b"])).toEqual({
      index: 0,
      message: "Argument 1 contains a null character, which a command can't receive.",
    });

    const instance = localInstance();
    const draft = acpAgentDraft(instance);
    const oversized = {
      ...draft,
      arguments: [...draft.arguments, { id: "long", value: `${longest}a` }],
    };
    expect(acpDraftProblem(instance, oversized)).toEqual({
      field: "argument",
      index: 1,
      message: "Argument 2 is longer than the 32,768-character limit.",
    });
    // A missing name is reported first, from the top of the form.
    expect(acpDraftProblem(instance, { ...oversized, displayName: " " })?.field).toBe("name");
  });
});

describe("acp agent model", () => {
  const ready = { status: "ready" as const, value: readyInspection() };
  const activity = (patch: Partial<AcpActivity>): AcpActivity => ({
    kind: "connect",
    operationId: "op",
    phase: "running",
    failure: null,
    result: null,
    cancelling: false,
    ...patch,
  });

  describe("ACP instance status", () => {
    test("a disabled instance is off regardless of its last known state", () => {
      expect(
        acpInstanceStatus({
          instance: registryInstance({ enabled: false }),
          inspection: ready,
          provider: providerSnapshot({
            models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }],
          }),
          activity: undefined,
        }),
      ).toMatchObject({ kind: "off", action: null });
    });

    test("a live operation outranks installation and connection state", () => {
      expect(
        acpInstanceStatus({
          instance: registryInstance(),
          inspection: ready,
          provider: undefined,
          activity: activity({
            kind: "install",
            progress: { phase: "downloading", downloadedBytes: 50, totalBytes: 200 },
          }),
        }),
      ).toMatchObject({ kind: "installing", detail: "25%", action: "cancel" });
    });

    test("an authentication failure asks for sign-in instead of reporting an error", () => {
      expect(
        acpInstanceStatus({
          instance: registryInstance(),
          inspection: ready,
          provider: undefined,
          activity: activity({
            phase: "failed",
            failure: { reason: "authentication_failed", message: "raw" },
          }),
        }),
      ).toMatchObject({ kind: "sign-in", action: "sign-in", tone: "default" });
    });

    test("passive installation state explains what the user must do", () => {
      const status = (inspection: Parameters<typeof readyInspection>[0]) =>
        acpInstanceStatus({
          instance: registryInstance(),
          inspection: { status: "ready", value: readyInspection(inspection) },
          provider: undefined,
          activity: undefined,
        });
      expect(status({ status: "unprepared" } as never)).toMatchObject({
        kind: "not-installed",
        action: "install",
      });
      expect(
        status({ status: "missing_runner", runner: "uv", distribution: "uvx" } as never),
      ).toMatchObject({ kind: "needs-runner", label: "Needs uv", action: null });
      expect(status({ status: "unsupported" } as never)).toMatchObject({ kind: "unsupported" });
    });

    test("a local command that can't be found says so instead of asking for a runner", () => {
      const missing = { reason: "runner_unavailable" as const, message: "Install the runner." };
      const failed = (instance: ReturnType<typeof localInstance>) =>
        acpInstanceStatus({
          instance,
          inspection: ready,
          provider: undefined,
          activity: activity({ phase: "failed", failure: missing }),
        });
      const commandNotFound = {
        label: "Command not found",
        detail: "Use an absolute path or a command on PATH.",
        action: null,
      };
      expect(failed(localInstance())).toMatchObject(commandNotFound);
      // The passive check agrees with what a failed connection reported.
      expect(
        acpInstanceStatus({
          instance: localInstance(),
          inspection: {
            status: "ready",
            value: readyInspection({ status: "missing_runner", distribution: "local" } as never),
          },
          provider: undefined,
          activity: undefined,
        }),
      ).toMatchObject(commandNotFound);
      // A Registry Agent's runner is a separate program the user installs.
      expect(failed(registryInstance())).toMatchObject({
        label: "Needs a runner",
        detail: "Install the runner.",
      });
    });

    test("discovery, not installation or sign-in, makes an Agent ready", () => {
      const model = { slug: "qfmodel", name: "Qwen", isCustom: false, capabilities: null };
      const startup = {
        slug: "default",
        name: "Default",
        isCustom: false,
        isDefault: true,
        capabilities: null,
      };
      const base = { instance: localInstance(), inspection: ready, activity: undefined };
      // Installed and signed in, but nothing has connected yet.
      expect(
        acpInstanceStatus({
          ...base,
          provider: providerSnapshot({ auth: { status: "authenticated" }, models: [model] }),
        }),
      ).toMatchObject({ kind: "not-connected", action: "connect" });
      // A real session confirmed the Agent has no model API.
      expect(
        acpInstanceStatus({
          ...base,
          provider: providerSnapshot({
            models: [startup],
            ...discovered({ supportsModelSelection: false }),
          }),
        }),
      ).toMatchObject({ kind: "ready", detail: "Startup model" });
      expect(
        acpInstanceStatus({
          ...base,
          provider: providerSnapshot({
            message: "spawn ENOENT",
            ...discovered({ status: "failed" }),
          }),
        }),
      ).toMatchObject({
        kind: "failed",
        label: "Couldn't connect",
        detail: "spawn ENOENT",
        action: "connect",
      });
    });

    test("an installed Agent is ready only after the Runtime learned its models", () => {
      const base = { instance: localInstance(), inspection: ready, activity: undefined };
      expect(acpInstanceStatus({ ...base, provider: undefined })).toMatchObject({
        kind: "not-connected",
        action: "connect",
      });
      expect(
        acpInstanceStatus({
          ...base,
          provider: providerSnapshot({
            models: [
              { slug: "qfmodel", name: "Qwen", isCustom: false, capabilities: null },
              { slug: "dfmodel", name: "DeepSeek", isCustom: false, capabilities: null },
            ],
            ...discovered(),
          }),
        }),
      ).toMatchObject({ kind: "ready", detail: "2 models" });
      expect(
        acpInstanceStatus({
          ...base,
          provider: providerSnapshot({ auth: { status: "unauthenticated" } }),
        }),
      ).toMatchObject({ kind: "sign-in" });
    });
  });

  describe("ACP presentation helpers", () => {
    test("busy failures name how many chats must stop first", () => {
      expect(
        acpFailureCopy(
          {
            reason: "busy",
            message: "raw",
            affectedSessions: [
              { sessionId: "a", threadId: "1" },
              { sessionId: "b", threadId: "2" },
            ],
          },
          "sign-out",
        ).title,
      ).toBe("In use by 2 chats. Stop them first.");
    });

    test("generic failures keep the Agent's specific message as detail", () => {
      expect(
        acpFailureCopy({ reason: "probe_failed", message: "session/new timed out" }, "connect"),
      ).toEqual({ title: "Couldn't connect to the Agent.", detail: "session/new timed out" });
    });

    test("sign-in methods merge auth reads and connection recovery without duplicates", () => {
      expect(
        acpSignInMethods(
          [{ id: "login", name: "Qoder login", description: null, type: "terminal" }],
          [
            { id: "login", name: "Qoder login", description: null, type: "terminal" },
            {
              id: "pat",
              name: "Access token",
              description: null,
              type: "env_var",
              envVarNames: ["QODER_PERSONAL_ACCESS_TOKEN"],
              link: "https://qoder.com/tokens",
            },
          ],
        ),
      ).toEqual([
        { kind: "terminal", id: "login", name: "Qoder login", description: null },
        {
          kind: "environment",
          id: "pat",
          name: "Access token",
          description: null,
          variables: ["QODER_PERSONAL_ACCESS_TOKEN"],
          link: "https://qoder.com/tokens",
        },
      ]);
    });

    test("pasted lines become arguments and the summary quotes spaces and empty values", () => {
      expect(splitPastedAcpArguments("--acp\r\n--model\nDeepSeek Flash\n")).toEqual([
        "--acp",
        "--model",
        "DeepSeek Flash",
      ]);
      expect(acpCommandLine("/opt/my agent/qoder", ["--acp", "a b", ""])).toBe(
        '"/opt/my agent/qoder" --acp "a b" ""',
      );
    });

    test("progress shows a percentage only for a known download size", () => {
      expect(
        acpProgressText({ phase: "downloading", downloadedBytes: 2_048, totalBytes: null }),
      ).toBe("2.0 KB");
      expect(acpProgressText({ phase: "verifying", downloadedBytes: 0, totalBytes: null })).toBe(
        "Verifying",
      );
      expect(
        acpProgressText({ phase: "installing", downloadedBytes: 0, totalBytes: null }),
      ).toBeNull();
    });

    test("updates come from the cached catalog for pinned Registry installs only", () => {
      expect(
        acpUpdateVersion(registryInstance(), readyInspection({ latestVersion: "0.3.0" } as never)),
      ).toBe("0.3.0");
      expect(acpUpdateVersion(registryInstance(), readyInspection())).toBeNull();
      expect(
        acpUpdateVersion(localInstance(), readyInspection({ latestVersion: "0.3.0" } as never)),
      ).toBeNull();
    });

    test("an unavailable Registry Agent explains the missing runner before the platform", () => {
      expect(
        acpRegistryUnavailableText(
          registryAgent({
            distribution: null,
            integrity: null,
            distributions: [
              { kind: "binary", available: false, runner: null, reason: "unsupported_platform" },
              { kind: "uvx", available: false, runner: "uv", reason: "runner_unavailable" },
            ],
          }),
        ),
      ).toBe("Requires uv");
    });

    test("another instance of the same Agent gets a distinct name", () => {
      expect(acpInstanceName("Qoder", ["qoder", "Qoder 2"])).toBe("Qoder 3");
      expect(acpInstanceName("Qoder", [])).toBe("Qoder");
    });
  });

  describe("ACP sign-in terminal output", () => {
    test("appends only unseen output and redraws after a gap the tail no longer covers", () => {
      expect(authTerminalDelta(0, "Login: ", 7)).toEqual({ reset: false, data: "Login: " });
      expect(authTerminalDelta(7, "Login: ok\r\n", 11)).toEqual({ reset: false, data: "ok\r\n" });
      expect(authTerminalDelta(11, "Login: ok\r\n", 11)).toEqual({ reset: false, data: "" });
      // 40 characters were produced but the bounded tail keeps 10.
      expect(authTerminalDelta(11, "0123456789", 51)).toEqual({ reset: true, data: "0123456789" });
    });
  });

  describe("ACP imported history", () => {
    const projection = (
      status: string,
      nativeImport?: { canLoad: boolean; canResume: boolean },
    ) => ({
      thread: { activeProviderThreadId: "imported" },
      providerThreads: [
        {
          id: "older",
          status: "not_loaded",
          nativeMetadata: { nativeImport: { canLoad: true, canResume: false } },
        },
        { id: "imported", status, nativeMetadata: nativeImport ? { nativeImport } : null },
      ],
    });

    test("only the active provider thread's unrestored import counts", () => {
      expect(
        acpPendingImportedHistory(projection("not_loaded", { canLoad: false, canResume: true })),
      ).toEqual({
        canLoad: false,
        canResume: true,
      });
      // Restoration moves the thread on; the metadata alone no longer means anything is pending.
      expect(
        acpPendingImportedHistory(projection("idle", { canLoad: true, canResume: false })),
      ).toBeNull();
      expect(acpPendingImportedHistory(projection("not_loaded"))).toBeNull();
      expect(
        acpPendingImportedHistory({
          thread: { activeProviderThreadId: null },
          providerThreads: [],
        }),
      ).toBeNull();
    });

    test("the empty transcript says whether earlier messages can come back", () => {
      expect(acpImportedHistoryEmptyState("Qoder", { canLoad: true, canResume: false })).toEqual({
        title: "Imported from Qoder",
        description: "Send a message to continue. Qoder will try to restore the earlier messages.",
      });
      expect(
        acpImportedHistoryEmptyState("Qoder", { canLoad: false, canResume: true }).description,
      ).toBe(
        "Send a message to continue. Qoder keeps the earlier context, but its messages can't be shown here.",
      );
    });
  });

  describe("acpAgentsSummary", () => {
    const status = (
      kind: AcpInstanceStatus["kind"],
      tone: AcpInstanceStatus["tone"] = "default",
    ): AcpInstanceStatus => ({ kind, label: kind, detail: null, tone, action: null });

    test("counts the agents and the ones waiting on the user", () => {
      expect(acpAgentsSummary([])).toEqual({ text: "None added", attention: null });
      expect(acpAgentsSummary([status("ready"), status("off", "muted")])).toEqual({
        text: "2 agents",
        attention: null,
      });
      expect(acpAgentsSummary([status("sign-in")])).toEqual({
        text: "1 agent",
        attention: "1 needs attention",
      });
      expect(
        acpAgentsSummary([
          status("not-installed"),
          status("failed", "danger"),
          status("connecting"),
        ]),
      ).toEqual({ text: "3 agents", attention: "2 need attention" });
    });
  });
});
