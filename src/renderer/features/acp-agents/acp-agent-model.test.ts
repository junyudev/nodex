import { describe, expect, test } from "vite-plus/test";
import {
  acpCommandLine,
  acpComposerSetupHint,
  acpFailureCopy,
  acpInstanceName,
  acpInstanceStatus,
  acpProgressText,
  acpRegistryUnavailableText,
  acpSignInMethods,
  acpTerminalDelta,
  acpUpdateVersion,
  splitPastedAcpArguments,
  type AcpActivity,
} from "./acp-agent-model";
import {
  localInstance,
  providerSnapshot,
  readyInspection,
  registryAgent,
  registryInstance,
} from "./acp-agents.test-fixtures";

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

  test("the startup Default alone doesn't make an unconnected Agent ready", () => {
    const startup = {
      slug: "default",
      name: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    };
    const base = { instance: localInstance(), inspection: ready, activity: undefined };
    expect(
      acpInstanceStatus({ ...base, provider: providerSnapshot({ models: [startup] }) }),
    ).toMatchObject({ kind: "not-connected", action: "connect" });
    expect(acpComposerSetupHint(providerSnapshot({ models: [startup] }))).toEqual({
      hint: "Connect",
      tone: "default",
    });
    // A real connection reports session capabilities, even for an Agent without a model API.
    expect(
      acpInstanceStatus({
        ...base,
        provider: providerSnapshot({
          models: [startup],
          nativeSessions: { canList: true, canLoad: true, canResume: false },
        }),
      }),
    ).toMatchObject({ kind: "ready", detail: "1 model" });
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
    expect(acpProgressText({ phase: "installing", downloadedBytes: 0, totalBytes: null })).toBe(
      "Installing",
    );
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

describe("ACP composer setup", () => {
  test("only unusable enabled instances are offered, with their next step", () => {
    const model = { slug: "m", name: "M", isCustom: false, capabilities: null };
    expect(acpComposerSetupHint(providerSnapshot({ models: [model] }))).toBeNull();
    expect(acpComposerSetupHint(providerSnapshot({ enabled: false }))).toBeNull();
    expect(
      acpComposerSetupHint(
        providerSnapshot({ auth: { status: "unauthenticated" }, models: [model] }),
      ),
    ).toEqual({ hint: "Sign in", tone: "default" });
    expect(acpComposerSetupHint(providerSnapshot({ installed: false }))).toEqual({
      hint: "Install",
      tone: "default",
    });
    expect(acpComposerSetupHint(providerSnapshot({ status: "error" }))).toEqual({
      hint: "Unavailable",
      tone: "danger",
    });
    expect(acpComposerSetupHint(providerSnapshot())).toEqual({ hint: "Connect", tone: "default" });
  });
});

describe("ACP sign-in terminal output", () => {
  test("appends only unseen output and redraws after a gap the tail no longer covers", () => {
    expect(acpTerminalDelta(0, "Login: ", 7)).toEqual({ reset: false, data: "Login: " });
    expect(acpTerminalDelta(7, "Login: ok\r\n", 11)).toEqual({ reset: false, data: "ok\r\n" });
    expect(acpTerminalDelta(11, "Login: ok\r\n", 11)).toEqual({ reset: false, data: "" });
    // 40 characters were produced but the bounded tail keeps 10.
    expect(acpTerminalDelta(11, "0123456789", 51)).toEqual({ reset: true, data: "0123456789" });
  });
});
