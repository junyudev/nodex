import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_MODEL_POLICY, withFreeModelsOn } from "../../../shared/model-policy";
import type { ProjectCandidate } from "../../../shared/project-discovery";
import {
  INITIAL_FIRST_RUN_STATE,
  candidateActivity,
  decideFirstRun,
  firstRunAgentRows,
  firstTaskForChoice,
  nextFirstRunStep,
  normalizeFirstRunState,
  offeredCandidates,
  orderFirstRunAgents,
  previousFirstRunStep,
  type FirstRunAgentInputs,
} from "./first-run-model";

type Provider = NonNullable<FirstRunAgentInputs["providers"]>[number];

const provider = (overrides: Partial<Provider> & Pick<Provider, "instanceId" | "driver">) =>
  ({
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    availability: "available",
    models: [],
    ...overrides,
  }) as Provider;

const inputs = (overrides: Partial<FirstRunAgentInputs> = {}): FirstRunAgentInputs => ({
  providers: [],
  policy: DEFAULT_MODEL_POLICY,
  codexLoginPending: false,
  nodex: {
    configured: false,
    signedIn: false,
    signingIn: false,
    identity: null,
    balance: null,
    notice: null,
  },
  openCodeInstall: "installable",
  ...overrides,
});

const row = (rows: ReturnType<typeof firstRunAgentRows>, id: string) =>
  rows.find((entry) => entry.id === id);

describe("first-run decision", () => {
  const pending = INITIAL_FIRST_RUN_STATE;

  it("waits until both the saved state and the workspace are known", () => {
    expect(decideFirstRun({ state: null, workspace: "empty" })).toBe("undecided");
    expect(decideFirstRun({ state: pending, workspace: null })).toBe("undecided");
  });

  it("shows on an empty Profile and never on one that already holds work", () => {
    expect(decideFirstRun({ state: pending, workspace: "empty" })).toBe("show");
    expect(decideFirstRun({ state: pending, workspace: "ready" })).toBe("hide");
  });

  it("opens the app when the workspace can't be read", () => {
    expect(decideFirstRun({ state: pending, workspace: "unknown" })).toBe("hide");
  });

  it("resumes a saved step even after that flow has created Projects", () => {
    const resumed = { ...pending, step: "projects" as const };
    expect(decideFirstRun({ state: resumed, workspace: "ready" })).toBe("show");
  });

  it("stays closed once finished, and reopens for an explicit replay", () => {
    const done = { ...pending, done: true };
    expect(decideFirstRun({ state: done, workspace: "empty" })).toBe("hide");
    const replay = { ...pending, step: "agents" as const, entry: "replay" as const };
    expect(decideFirstRun({ state: replay, workspace: "ready" })).toBe("show");
  });
});

describe("first-run state decoding", () => {
  it("falls back to a fresh state for anything unrecognizable", () => {
    expect(normalizeFirstRunState(null)).toEqual(INITIAL_FIRST_RUN_STATE);
    expect(normalizeFirstRunState({ step: "elsewhere", entry: "other" })).toEqual(
      INITIAL_FIRST_RUN_STATE,
    );
  });

  it("keeps a saved step and entry", () => {
    const saved = {
      done: false,
      step: "projects",
      entry: "replay",
    };
    expect(normalizeFirstRunState({ version: 1, ...saved })).toEqual(saved);
  });
});

describe("first-run steps", () => {
  it("walks the steps in order", () => {
    expect(nextFirstRunStep("first-run", "agents")).toBe("projects");
    expect(nextFirstRunStep("first-run", "projects")).toBeNull();
    expect(previousFirstRunStep("first-run", "agents")).toBeNull();
    expect(previousFirstRunStep("first-run", "projects")).toBe("agents");
  });

  it("ends after Agents when opened only to connect one", () => {
    expect(nextFirstRunStep("connect", "agents")).toBeNull();
  });
});

describe("first-run Agents", () => {
  it("checks until the first catalog read answers", () => {
    const rows = firstRunAgentRows(inputs({ providers: null }));
    expect(row(rows, "codex")?.state).toBe("checking");
    expect(row(rows, "claude")?.state).toBe("checking");
  });

  it("shows who is signed in and asks nothing of a ready Agent", () => {
    const rows = firstRunAgentRows(
      inputs({
        providers: [
          provider({
            instanceId: "codex",
            driver: "codex",
            auth: { status: "authenticated", email: "a@example.com" },
          }),
        ],
      }),
    );
    expect(row(rows, "codex")).toMatchObject({
      state: "ready",
      detail: "a@example.com",
      action: null,
    });
  });

  it("offers the fix that matches why an Agent can't run", () => {
    const rows = firstRunAgentRows(
      inputs({
        providers: [
          provider({
            instanceId: "codex",
            driver: "codex",
            auth: { status: "unauthenticated" },
          }),
          provider({
            instanceId: "claude",
            driver: "claudeAgent",
            installed: false,
            status: "error",
            auth: { status: "unknown" },
          }),
        ],
      }),
    );
    expect(row(rows, "codex")?.action?.kind).toBe("codex-sign-in");
    expect(row(rows, "claude")?.action?.kind).toBe("claude-install");
  });

  it("says when an Agent isn't ready and leaves a turned-off one alone", () => {
    const rows = firstRunAgentRows(
      inputs({
        providers: [
          provider({
            instanceId: "codex",
            driver: "codex",
            availability: "unavailable",
          } as Partial<Provider> & Pick<Provider, "instanceId" | "driver">),
          provider({ instanceId: "claude", driver: "claudeAgent", enabled: false }),
        ],
      }),
    );
    expect(row(rows, "codex")).toMatchObject({ state: "action", action: null });
    expect(row(rows, "claude")).toBeUndefined();
  });

  it("waits on a browser sign-in and lets it be cancelled", () => {
    const rows = firstRunAgentRows(inputs({ codexLoginPending: true }));
    expect(row(rows, "codex")).toMatchObject({
      state: "waiting",
      action: { kind: "codex-cancel-sign-in" },
    });
  });

  describe("Nodex credits", () => {
    const nodex = { ...inputs().nodex, configured: true };
    const nodexRowFor = (overrides: Partial<typeof nodex>) =>
      row(firstRunAgentRows(inputs({ nodex: { ...nodex, ...overrides } })), "nodex");

    it("is absent from a build without accounts", () => {
      expect(row(firstRunAgentRows(inputs()), "nodex")).toBeUndefined();
    });

    it("offers a start that covers a new account and an existing one", () => {
      expect(nodexRowFor({})).toMatchObject({
        state: "action",
        action: { kind: "nodex-sign-in", label: "Get started" },
      });
      expect(nodexRowFor({ identity: "ada@example.com" })).toMatchObject({
        detail: "ada@example.com · Sign in again",
        action: { kind: "nodex-sign-in", label: "Sign in" },
      });
    });

    it("can be cancelled while signing in", () => {
      expect(nodexRowFor({ signingIn: true })).toMatchObject({
        state: "waiting",
        action: { kind: "nodex-cancel-sign-in" },
      });
    });

    it("opens the top-up tiers only once an empty wallet has actually been read", () => {
      const signedIn = { signedIn: true, identity: "ada@example.com" };
      expect(nodexRowFor({ ...signedIn, balance: null })?.offersTopUp).toBe(false);
      expect(nodexRowFor({ ...signedIn, balance: 0 })).toMatchObject({
        detail: "ada@example.com · No credits yet",
        state: "action",
        offersTopUp: true,
      });
    });

    it("is ready only with a whole credit to spend", () => {
      expect(nodexRowFor({ signedIn: true, balance: 0.4 })).toMatchObject({
        state: "action",
        offersTopUp: true,
      });
      expect(nodexRowFor({ signedIn: true, balance: 1275.9 })).toMatchObject({
        state: "ready",
        detail: "1,275 credits",
      });
    });

    it("says what went wrong in place of its usual detail", () => {
      expect(nodexRowFor({ notice: "Couldn't reach Nodex." })?.detail).toBe(
        "Couldn't reach Nodex.",
      );
    });
  });

  it("offers OpenCode's free models only as an explicit choice", () => {
    const openCode = provider({
      instanceId: "opencode",
      driver: "opencode",
      models: [
        { slug: "big-pickle-free" },
        { slug: "paid-model" },
      ] as unknown as Provider["models"],
    });
    const before = firstRunAgentRows(
      inputs({ providers: [openCode], openCodeInstall: "installed" }),
    );
    expect(row(before, "opencode")).toMatchObject({
      state: "action",
      action: { kind: "opencode-use" },
    });
    expect(row(before, "opencode")?.detail).toContain("may keep what you send");

    const after = firstRunAgentRows(
      inputs({
        providers: [openCode],
        openCodeInstall: "installed",
        policy: withFreeModelsOn(DEFAULT_MODEL_POLICY, openCode),
      }),
    );
    expect(row(after, "opencode")).toMatchObject({ state: "ready", detail: "1 model on" });
  });

  it("offers to install OpenCode when it's missing, and hides it where it can't run", () => {
    expect(row(firstRunAgentRows(inputs()), "opencode")?.action?.kind).toBe("opencode-install");
    expect(
      row(firstRunAgentRows(inputs({ openCodeInstall: "unavailable" })), "opencode"),
    ).toBeUndefined();
  });

  it("puts usable Agents first without otherwise reordering", () => {
    const rows = firstRunAgentRows(
      inputs({
        providers: [
          provider({
            instanceId: "codex",
            driver: "codex",
            auth: { status: "unauthenticated" },
          }),
          provider({ instanceId: "claude", driver: "claudeAgent" }),
        ],
      }),
    );
    expect(orderFirstRunAgents(rows)).toEqual(["claude", "codex", "opencode"]);
  });
});

describe("first-run projects", () => {
  const candidate = (
    path: string,
    overrides: Partial<ProjectCandidate> = {},
  ): ProjectCandidate => ({
    path,
    displayPath: path,
    name: path,
    repository: null,
    isGitRepository: true,
    chatCount: 3,
    lastActiveAt: 0,
    suggested: true,
    recentChats: [],
    ...overrides,
  });

  it("offers only folders that aren't Projects yet", () => {
    const candidates = [candidate("/work/a"), candidate("/work/b")];
    expect(offeredCandidates(candidates, new Set(["/work/a"])).map((entry) => entry.path)).toEqual([
      "/work/b",
    ]);
  });

  it("picks the first task from where the person chose to work", () => {
    expect(firstTaskForChoice(null)).toBe("no-project");
    expect(
      firstTaskForChoice({ key: "e", kind: "empty", name: "E", path: null, candidate: null }),
    ).toBe("empty-folder");
    expect(
      firstTaskForChoice({ key: "f", kind: "folder", name: "F", path: "/f", candidate: null }),
    ).toBe("existing-folder");
  });

  it("describes a folder's activity in plain words", () => {
    const now = 100 * 24 * 60 * 60_000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60_000;
    expect(candidateActivity(candidate("/a", { lastActiveAt: twoDaysAgo }), now)).toBe(
      "3 chats · 2 days ago",
    );
    expect(candidateActivity(candidate("/a", { chatCount: 1, lastActiveAt: now }), now)).toBe(
      "1 chat · just now",
    );
  });
});
