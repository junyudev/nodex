import { describe, expect, it } from "vitest";
import { sessionMessageCeilingError, type SessionMessageFacts } from "./session-message-policy";
const facts = (overrides: Partial<SessionMessageFacts> = {}): SessionMessageFacts => ({
  sessionId: "session",
  threadId: "thread",
  runtimeMode: "full-access",
  interactionMode: "default",
  modelSelection: { instanceId: "codex", model: "model" },
  ...overrides,
});
describe("Session send authority ceiling", () => {
  it("allows self sends and narrower settings, without widening caller permissions", () => {
    expect(sessionMessageCeilingError(facts(), facts())).toBeNull();
    expect(
      sessionMessageCeilingError(
        facts({ runtimeMode: "auto-accept-edits" }),
        facts({ runtimeMode: "auto" }),
      ),
    ).toBe("runtime_mode_escalation_denied");
    expect(
      sessionMessageCeilingError(
        facts({ nativeSandbox: "readOnly" }),
        facts({ nativeSandbox: "workspaceWrite" }),
      ),
    ).toBe("runtime_mode_escalation_denied");
    expect(
      sessionMessageCeilingError(
        facts(),
        facts({ runtimeMode: "approval-required", interactionMode: "plan" }),
      ),
    ).toBeNull();
    expect(sessionMessageCeilingError(facts({ runtimeMode: "approval-required" }), facts())).toBe(
      "runtime_mode_escalation_denied",
    );
    expect(sessionMessageCeilingError(facts({ interactionMode: "plan" }), facts())).toBe(
      "interaction_mode_escalation_denied",
    );
    expect(
      sessionMessageCeilingError(
        facts({ interactionMode: "plan" }),
        facts({ interactionMode: "plan" }),
      ),
    ).toBeNull();
  });
});

it("retains exact Native network, writable roots, temp and approval ceilings", () => {
  const source = {
    sandboxPolicy: {
      type: "workspaceWrite" as const,
      writableRoots: ["/work"],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    },
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    runtimeWorkspaceRoots: ["/runtime"],
  };
  const restricted = facts({
    runtimeMode: "approval-required",
    nativeSandbox: "workspaceWrite",
    nativePermissions: source,
    executionHostId: "host",
  });
  const destination = (permissions: typeof source) =>
    facts({ ...restricted, nativePermissions: permissions });
  expect(
    sessionMessageCeilingError(
      restricted,
      destination({
        ...source,
        sandboxPolicy: { ...source.sandboxPolicy, writableRoots: ["/work/child"] },
      }),
    ),
  ).toBeNull();
  for (const sandbox of [
    { ...source.sandboxPolicy, networkAccess: true },
    { ...source.sandboxPolicy, writableRoots: ["/work-other"] },
    { ...source.sandboxPolicy, excludeSlashTmp: false },
    { ...source.sandboxPolicy, excludeTmpdirEnvVar: false },
  ])
    expect(
      sessionMessageCeilingError(restricted, destination({ ...source, sandboxPolicy: sandbox })),
    ).toBe("runtime_mode_escalation_denied");
  expect(
    sessionMessageCeilingError(
      restricted,
      facts({ ...restricted, nativePermissions: { ...source, approvalPolicy: "never" } }),
    ),
  ).toBe("runtime_mode_escalation_denied");
  expect(
    sessionMessageCeilingError(
      restricted,
      facts({
        ...restricted,
        nativePermissions: { ...source, runtimeWorkspaceRoots: ["/outside"] },
      }),
    ),
  ).toBe("runtime_mode_escalation_denied");
  expect(
    sessionMessageCeilingError(restricted, facts({ ...restricted, executionHostId: "other" })),
  ).toBe("runtime_mode_escalation_denied");
});
