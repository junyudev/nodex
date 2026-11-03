import { describe, expect, test, vi } from "vite-plus/test";
import {
  agentReadinessNotice,
  agentReadinessProblem,
  agentReadinessSetupHint,
} from "./agent-readiness-notice";

type Snapshot = Parameters<typeof agentReadinessProblem>[0] & {};

const ready: Snapshot = {
  instanceId: "codex",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
};

const snapshot = (patch: Partial<Snapshot>): Snapshot => ({ ...ready, ...patch });

const fixes = () => ({
  signIn: vi.fn(async () => {}),
  openSettings: vi.fn(),
  checkAgain: vi.fn(async () => {}),
});

const actionLabels = (notice: ReturnType<typeof agentReadinessNotice>) =>
  notice?.actions?.map((action) => action.label);

describe("agentReadinessProblem", () => {
  test("a usable Agent, including one whose warning leaves it usable, has no problem", () => {
    expect(agentReadinessProblem(undefined)).toBeNull();
    expect(agentReadinessProblem(ready)).toBeNull();
    expect(
      agentReadinessProblem(
        snapshot({
          status: "warning",
          installed: false,
          auth: { status: "unknown" },
          message: "Codex provider status has not been checked in this session yet.",
        }),
      ),
    ).toBeNull();
  });

  test("reads the problem from the checked state, most fundamental first", () => {
    expect(
      agentReadinessProblem(
        snapshot({ availability: "unavailable", enabled: false, status: "disabled" }),
      ),
    ).toBe("not-ready");
    expect(agentReadinessProblem(snapshot({ enabled: false, status: "disabled" }))).toBe(
      "turned-off",
    );
    expect(
      agentReadinessProblem(snapshot({ status: "error", auth: { status: "unauthenticated" } })),
    ).toBe("signed-out");
    // A signed-out Agent is a problem even while its status is only a warning.
    expect(
      agentReadinessProblem(snapshot({ status: "warning", auth: { status: "unauthenticated" } })),
    ).toBe("signed-out");
    expect(
      agentReadinessProblem(
        snapshot({ status: "error", installed: false, auth: { status: "unknown" } }),
      ),
    ).toBe("not-installed");
    expect(agentReadinessProblem(snapshot({ status: "error" }))).toBe("not-ready");
  });
});

describe("agentReadinessNotice", () => {
  test("a signed-out Agent that signs in from Nodex asks for exactly that", () => {
    const notice = agentReadinessNotice(
      "Codex",
      snapshot({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Codex CLI is not authenticated. Run `codex login` and try again.",
      }),
      fixes(),
    );

    expect(notice).toMatchObject({
      key: "agent:codex:signed-out",
      tone: "warning",
      title: "Codex isn’t signed in",
      detail: null,
    });
    expect(actionLabels(notice)).toEqual(["Sign in", "Check again"]);
  });

  test("a signed-out Agent that signs in elsewhere keeps its instructions and its settings", () => {
    const { signIn: _signIn, ...withoutSignIn } = fixes();
    const notice = agentReadinessNotice(
      "Claude",
      snapshot({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
      }),
      withoutSignIn,
    );

    expect(notice?.detail).toBe(
      "Claude Code is not authenticated. Run `claude auth login` and try again.",
    );
    expect(actionLabels(notice)).toEqual(["Settings", "Check again"]);
  });

  test("each problem gets its own title, tone and fixes", () => {
    const missing = agentReadinessNotice(
      "Claude",
      snapshot({
        status: "error",
        installed: false,
        auth: { status: "unknown" },
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      }),
      fixes(),
    );
    expect(missing).toMatchObject({ tone: "warning", title: "Claude isn’t installed" });
    expect(actionLabels(missing)).toEqual(["Settings", "Check again"]);

    const broken = agentReadinessNotice(
      "OpenCode",
      snapshot({ status: "error", message: "OpenCode v1.2.0 is too old." }),
      fixes(),
    );
    expect(broken).toMatchObject({
      tone: "danger",
      title: "OpenCode isn’t ready",
      detail: "OpenCode v1.2.0 is too old.",
    });
    expect(actionLabels(broken)).toEqual(["Check again", "Settings"]);

    // The title already says the Agent is off; its "disabled in settings" message would repeat it.
    const off = agentReadinessNotice(
      "Codex",
      snapshot({
        enabled: false,
        status: "disabled",
        message: "Codex is disabled in Nodex settings.",
      }),
      fixes(),
    );
    expect(off).toMatchObject({ tone: "warning", title: "Codex is turned off" });
    expect(off?.detail).toBeUndefined();
    expect(actionLabels(off)).toEqual(["Settings"]);
  });

  test("a missing driver explains itself with its unavailable reason", () => {
    const notice = agentReadinessNotice(
      "Cursor",
      snapshot({
        availability: "unavailable",
        enabled: false,
        status: "disabled",
        unavailableReason: "Driver 'cursor' is not registered in this build.",
        message: "Driver 'cursor' is not registered in this build.",
      }),
      fixes(),
    );

    expect(notice).toMatchObject({
      tone: "danger",
      title: "Cursor isn’t ready",
      detail: "Driver 'cursor' is not registered in this build.",
    });
  });

  test("its actions are the fixes it was given", async () => {
    const given = fixes();
    const notice = agentReadinessNotice(
      "Codex",
      snapshot({ status: "error", auth: { status: "unauthenticated" } }),
      given,
    );

    for (const action of notice?.actions ?? []) await action.run();
    expect(given.signIn).toHaveBeenCalledOnce();
    expect(given.checkAgain).toHaveBeenCalledOnce();
  });
});

describe("agentReadinessSetupHint", () => {
  test("names the next step for a turned-on Agent and stays out of a turned-off one", () => {
    expect(agentReadinessSetupHint(ready)).toBeNull();
    expect(agentReadinessSetupHint(snapshot({ enabled: false, status: "disabled" }))).toBeNull();
    expect(
      agentReadinessSetupHint(snapshot({ status: "error", auth: { status: "unauthenticated" } })),
    ).toEqual({ hint: "Sign in", tone: "default" });
    expect(
      agentReadinessSetupHint(
        snapshot({ status: "error", installed: false, auth: { status: "unknown" } }),
      ),
    ).toEqual({ hint: "Install", tone: "default" });
    expect(agentReadinessSetupHint(snapshot({ status: "error" }))).toEqual({
      hint: "Unavailable",
      tone: "danger",
    });
  });
});
