import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_MODEL_POLICY, withFreeModelsOn } from "../../../shared/model-policy";
import {
  antigravityInspection,
  managedAntigravityExecutable,
} from "../../../shared/antigravity-runtime.test-support";
import type { ProjectCandidate } from "../../../shared/project-discovery";
import type { AcpInstanceStatus } from "../acp-agents/acp-agent-model";
import {
  INITIAL_FIRST_RUN_STATE,
  arrangeFirstRunAgents,
  candidateActivity,
  decideFirstRun,
  firstRunAgentRows,
  firstTaskForChoice,
  nextFirstRunStep,
  normalizeFirstRunState,
  offeredCandidates,
  placeFirstRunAgents,
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
  antigravityInspection: antigravityInspection(),
  acpAgents: [],
  providerKeys: [],
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

  it("says what went wrong with an installed Agent and always offers to check again", () => {
    const codex = (overrides: Partial<Provider>) =>
      row(
        firstRunAgentRows(
          inputs({
            providers: [
              provider({ instanceId: "codex", driver: "codex", status: "error", ...overrides }),
            ],
          }),
        ),
        "codex",
      );
    // Signed in on this computer, with an account that couldn't be reached: a network problem.
    expect(
      codex({
        issue: "account-unavailable",
        auth: { status: "authenticated", email: "a@example.com" },
        message: "workspace routing discovery failed",
      }),
    ).toEqual(
      expect.objectContaining({
        state: "action",
        found: true,
        detail: "a@example.com · Can’t connect. Check your network or proxy.",
        action: expect.objectContaining({ kind: "check-again" }),
      }),
    );
    // Offline, only the kind of sign-in is known.
    expect(
      codex({ issue: "account-unavailable", auth: { status: "authenticated", label: "ChatGPT" } }),
    ).toMatchObject({
      detail: "Signed in with ChatGPT · Can’t connect. Check your network or proxy.",
    });
    expect(codex({ issue: "account-unavailable" })).not.toHaveProperty("note");
    expect(codex({ issue: "unresponsive", auth: { status: "unknown" } })).toMatchObject({
      detail: "Didn’t respond in time",
      action: { kind: "check-again" },
    });
    // Anything else carries the Agent's own words beneath the row.
    expect(
      codex({ issue: "failed", auth: { status: "unknown" }, message: "exited with code 2" }),
    ).toMatchObject({
      detail: "Couldn’t start",
      note: "exited with code 2",
      action: { kind: "check-again" },
    });
    // Codex ships with Nodex, so it is never offered as something to install or sign in to.
    expect(codex({ installed: false, auth: { status: "unknown" } })?.action?.kind).toBe(
      "check-again",
    );
  });

  it("leaves a turned-off Agent alone", () => {
    const rows = firstRunAgentRows(
      inputs({
        providers: [
          provider({ instanceId: "codex", driver: "codex", enabled: false }),
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

  describe("places", () => {
    const slots = (rows: ReturnType<typeof firstRunAgentRows>) =>
      placeFirstRunAgents([], rows).map((place) => place.slot);

    it("puts usable Agents first, then the ones found here, then the rest", () => {
      const rows = firstRunAgentRows(
        inputs({
          providers: [
            provider({ instanceId: "codex", driver: "codex", auth: { status: "unauthenticated" } }),
            provider({
              instanceId: "claude",
              driver: "claudeAgent",
              auth: { status: "unauthenticated" },
            }),
          ],
        }),
      );
      // Claude Code is installed and only needs a sign-in; Codex and an API key start from nothing.
      expect(row(rows, "claude")).toMatchObject({
        found: true,
        action: { kind: "claude-sign-in" },
      });
      expect(slots(rows).indexOf("claude")).toBeLessThan(slots(rows).indexOf("codex"));
      expect(slots(rows).indexOf("codex")).toBeLessThan(slots(rows).indexOf("api-key"));
    });

    it("never moves a placed slot, and seats a late one at the end of its tier", () => {
      const before = firstRunAgentRows(
        inputs({
          providers: [provider({ instanceId: "codex", driver: "codex" })],
          antigravityInspection: antigravityInspection(),
        }),
      );
      const placed = placeFirstRunAgents([], before);
      expect(placeFirstRunAgents(placed, before)).toBe(placed);

      const after = firstRunAgentRows(
        inputs({
          // Codex stopped answering after it was placed first; its row stays where it was.
          providers: [
            provider({
              instanceId: "codex",
              driver: "codex",
              status: "error",
              issue: "unresponsive",
            }),
          ],
          acpAgents: [
            {
              id: "late",
              label: "Late Agent",
              agentDefinitionId: "late-acp",
              status: {
                kind: "sign-in",
                label: "Sign in",
                action: "sign-in",
                tone: "default",
                detail: null,
              },
            },
          ],
        }),
      );
      expect(
        arrangeFirstRunAgents(after, placeFirstRunAgents(placed, after)).map((entry) => entry.id),
      ).toEqual(["codex", "acp:late", "claude", "antigravity", "api-key", "opencode"]);
    });
  });

  it("keeps Nodex credits and API keys out of the Claude Code row", () => {
    const rows = firstRunAgentRows(
      inputs({
        providers: [
          provider({
            instanceId: "claude",
            driver: "claudeAgent",
            auth: { status: "unauthenticated" },
          }),
          provider({ instanceId: "key_deepseek_abc", driver: "claudeAgent" }),
        ],
      }),
    );
    expect(row(rows, "claude")?.action?.kind).toBe("claude-sign-in");
  });

  describe("Agents on this computer", () => {
    const status = (overrides: Partial<AcpInstanceStatus>): AcpInstanceStatus => ({
      kind: "ready",
      label: "Ready",
      detail: "6 models",
      tone: "info",
      action: null,
      ...overrides,
    });
    const instance = (overrides: Partial<AcpInstanceStatus>) => ({
      id: "i1",
      label: "Custom Agent",
      agentDefinitionId: "custom-acp",
      status: status(overrides),
    });

    it("offers Antigravity setup as its own built-in Agent", () => {
      expect(row(firstRunAgentRows(inputs()), "antigravity")).toMatchObject({
        mark: { kind: "antigravity" },
        detail: "Not set up",
        action: { kind: "antigravity-settings", label: "Set up" },
      });
    });

    it("groups a PATH or downloaded runtime above Agents that need installing", () => {
      const path = {
        ...managedAntigravityExecutable,
        executablePath: "/tools/agy",
        source: "path",
        managedVersionDirectory: null,
      } as const;
      for (const inspection of [
        antigravityInspection({ path }),
        antigravityInspection({ managed: managedAntigravityExecutable }),
      ]) {
        const rows = firstRunAgentRows(inputs({ antigravityInspection: inspection }));
        expect(row(rows, "antigravity")).toMatchObject({
          found: true,
          action: { kind: "antigravity-settings", label: "Set up" },
        });
        expect(arrangeFirstRunAgents(rows, placeFirstRunAgents([], rows))[0]?.id).toBe(
          "antigravity",
        );
      }
    });

    it("shows the required version and lets the person check again after updating", () => {
      const path = {
        executablePath: "/tools/agy",
        source: "path",
        version: "1.4.9",
        managedVersionDirectory: null,
      } as const;
      const inspect = antigravityInspection({ path });
      expect(
        row(firstRunAgentRows(inputs({ antigravityInspection: inspect })), "antigravity"),
      ).toMatchObject({
        found: true,
        detail: "Found agy 1.4.9 · Update to 1.5.0 or newer to connect",
        action: { kind: "check-again" },
      });
    });

    it("marks Antigravity ready when an installed profile is signed in", () => {
      const account = provider({
        instanceId: "antigravity_work",
        driver: "antigravity",
        auth: { status: "authenticated", email: "work@example.test" },
      });
      const project = (providers: readonly Provider[]) =>
        row(firstRunAgentRows(inputs({ providers })), "antigravity");
      expect(project([account])).toMatchObject({
        state: "ready",
        detail: "work@example.test",
        action: null,
      });
      expect(project([{ ...account, checkPending: true }])).toMatchObject({ state: "checking" });
      expect(project([{ ...account, auth: { status: "unauthenticated" } }])).toMatchObject({
        state: "action",
        action: { kind: "antigravity-settings", label: "Sign in" },
      });
      expect(project([{ ...account, status: "error", issue: "unresponsive" }])).toMatchObject({
        detail: "Didn’t respond in time",
        action: { kind: "check-again" },
      });
    });

    it("asks a configured Agent for its next step", () => {
      expect(
        row(firstRunAgentRows(inputs({ acpAgents: [instance({ kind: "sign-in" })] })), "acp:i1")
          ?.action,
      ).toMatchObject({ kind: "acp-sign-in", target: "i1" });
      expect(
        row(
          firstRunAgentRows(
            inputs({ acpAgents: [instance({ kind: "not-connected", action: "connect" })] }),
          ),
          "acp:i1",
        )?.action?.kind,
      ).toBe("acp-connect");
      expect(
        row(firstRunAgentRows(inputs({ acpAgents: [instance({ kind: "off" })] })), "acp:i1"),
      ).toBeUndefined();
    });
  });

  it("lists connected API keys above the way to add another", () => {
    const connection = {
      id: "c1",
      preset: "deepseek",
      endpoint: "international",
      baseUrl: null,
      displayName: "DeepSeek",
      enabled: true,
      models: [{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
      keyHint: "3f2a",
    } as const;
    const rows = firstRunAgentRows(inputs({ providerKeys: [connection] }));
    const ids = rows.map((entry) => entry.id);
    expect(ids.indexOf("key:c1")).toBe(ids.indexOf("api-key") - 1);
    expect(row(rows, "key:c1")).toMatchObject({ state: "ready", detail: "1 model · ••••3f2a" });
    expect(row(rows, "api-key")).toMatchObject({
      label: "Another API key",
      action: { kind: "api-key-add" },
    });
    expect(
      row(
        firstRunAgentRows(inputs({ providerKeys: [{ ...connection, enabled: false }] })),
        "key:c1",
      ),
    ).toBeUndefined();
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
    expect(
      offeredCandidates(candidates, new Set(["/work/a"]), "recent").map((entry) => entry.path),
    ).toEqual(["/work/b"]);
  });

  it("lists folders strictly in the chosen order, a tie going to the other measure", () => {
    const candidates = [
      candidate("/work/repo", { chatCount: 9, lastActiveAt: 10 }),
      candidate("/work/notes", { isGitRepository: false, chatCount: 2, lastActiveAt: 30 }),
      candidate("/work/busy", { chatCount: 40, lastActiveAt: 20 }),
      candidate("/work/twin", { chatCount: 9, lastActiveAt: 30 }),
    ];
    const paths = (order: "recent" | "chats") =>
      offeredCandidates(candidates, new Set(), order).map((entry) => entry.path);
    // A folder outside Git is listed by when it was used, not behind every repository.
    expect(paths("recent")).toEqual(["/work/twin", "/work/notes", "/work/busy", "/work/repo"]);
    expect(paths("chats")).toEqual(["/work/busy", "/work/twin", "/work/repo", "/work/notes"]);
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
