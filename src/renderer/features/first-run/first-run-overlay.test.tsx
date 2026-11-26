import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project, ProjectCreateInput } from "@/lib/types";
import type { ProjectCandidate } from "../../../shared/project-discovery";
import type { FirstRunTeam } from "./first-run-agents";
import { FirstRunOverlay, type FirstRunOverlayProps } from "./first-run-overlay";
import {
  INITIAL_FIRST_RUN_STATE,
  firstTaskPrompt,
  type FirstRunAgentRow,
  type FirstRunState,
} from "./first-run-model";

const state = vi.hoisted(() => ({
  current: null as FirstRunState | null,
  agents: [] as FirstRunAgentRow[],
  anyReady: true,
  team: null as FirstRunTeam | null,
  settled: true,
  nodexAct: vi.fn(),
  candidates: [] as ProjectCandidate[],
  scanning: false,
  run: vi.fn(),
  imports: vi.fn(),
  ensureFolder: vi.fn(async (folder: string) => ({
    kind: "project" as const,
    projectId: `created:${folder.split("/").at(-1)}`,
    name: folder,
  })),
  chooseFolders: vi.fn(async (): Promise<string[]> => []),
}));

// The fade away runs on animation frames, and what follows it isn't what these tests are about.
vi.mock("motion/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("motion/react")>()),
  AnimatePresence: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.mock("./first-run-state", () => ({
  useFirstRunState: () => ({
    state: state.current,
    goTo: async (step: FirstRunState["step"]) => {
      state.current = { ...state.current!, step };
      act(() => rerender());
    },
    finish: async () => {
      state.current = { ...state.current!, done: true, step: null };
      act(() => finished());
    },
  }),
}));
vi.mock("./first-run-agents", () => ({
  useFirstRunTeam: () => state.team,
  useFirstRunAgents: () => ({
    rows: state.agents,
    settled: state.settled,
    anyReady: state.anyReady,
    nodexAccount: {
      pending: null,
      act: state.nodexAct,
      snapshot: {
        modelStatus: {
          creditsPerUsd: 25,
          models: [],
          topUp: {
            available: true,
            currency: "USD",
            tiers: [
              { amount: 5, credit: 5, available: true },
              { amount: 10, credit: 11, available: true },
            ],
          },
        },
      },
    },
    checkAgain: vi.fn(),
    run: state.run,
    useBrowserApiKey: vi.fn(),
  }),
}));
vi.mock("./first-run-projects", () => ({
  chooseProjectFolders: state.chooseFolders,
  createFolderProject: state.ensureFolder,
  importRecentChats: state.imports,
  useChatImportProgress: () => null,
  useFolderLabel: () => (path: string) => path,
  useProjectCandidates: () => ({
    data: { candidates: state.candidates, truncated: false },
    isPending: state.scanning,
  }),
}));
vi.mock("./first-run-terminal", () => ({
  firstRunTerminalSetup: () => ({
    previewInstall: () => "curl -fsSL https://claude.ai/install.sh | bash",
    signInCommand: async () => "claude auth login",
  }),
  runSetupTerminal: () => () => undefined,
}));
vi.mock("@/components/board/terminal-panel", () => ({
  TerminalPanel: () => <div data-testid="terminal" />,
}));

let rerender: () => void = () => undefined;
let finished: () => void = () => undefined;

const project = (id: string, path: string): Project =>
  ({ id, name: id, sources: [{ kind: "directory", path, order: 0 }] }) as unknown as Project;

// One instant for every folder: the list orders by last use, so two folders stamped a
// millisecond apart would swap places depending on how fast the fixtures were built.
const scannedAt = Date.now();

const candidate = (path: string, overrides: Partial<ProjectCandidate> = {}): ProjectCandidate => ({
  path,
  displayPath: path,
  name: path.split("/").at(-1)!,
  repository: null,
  isGitRepository: true,
  chatCount: 4,
  lastActiveAt: scannedAt,
  suggested: true,
  recentChats: [],
  scheduledTasks: [],
  ...overrides,
});

function setup(overrides: Partial<FirstRunOverlayProps> = {}) {
  const beginClosing = vi.fn();
  const stepAsideForSettings = vi.fn();
  const onOpenSettings = vi.fn();
  const onStartNewChatWithPrompt = vi.fn(async () => undefined);
  const onStartNewChat = vi.fn(async () => undefined);
  const onCreateProject = vi.fn(async (input: ProjectCreateInput) =>
    project(`created:${input.name}`, input.sources?.[0] ?? ""),
  );
  let props: FirstRunOverlayProps = {
    presentation: {
      undecided: false,
      showing: true,
      workbenchInert: true,
      beginClosing,
      stepAsideForSettings,
    },
    projects: [],
    insets: { left: 92, right: 12 },
    onCreateProject,
    onStartNewChatWithPrompt,
    onStartNewChat,
    onOpenSettings,
    ...overrides,
  };
  const view = render(<FirstRunOverlay {...props} />);
  rerender = () => view.rerender(<FirstRunOverlay {...props} />);
  finished = () => {
    props = {
      ...props,
      presentation: { ...props.presentation, showing: false, workbenchInert: false },
    };
    rerender();
  };
  return {
    onStartNewChatWithPrompt,
    onStartNewChat,
    onCreateProject,
    ...overrides,
    beginClosing,
    stepAsideForSettings,
    onOpenSettings,
  };
}

const readyAgent: FirstRunAgentRow = {
  id: "codex",
  slot: "codex",
  mark: { kind: "agent", driver: "codex" },
  label: "Codex",
  detail: "a@example.com",
  state: "ready",
  found: true,
  action: null,
};

const primary = (name: string | RegExp) => screen.getByRole("button", { name });

const isDisabled = (element: HTMLElement) => (element as HTMLButtonElement).disabled;
const isChecked = (element: HTMLElement) => element.getAttribute("aria-checked") === "true";

const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};

beforeEach(() => {
  state.current = { ...INITIAL_FIRST_RUN_STATE, step: "agents" };
  state.agents = [readyAgent];
  state.anyReady = true;
  state.team = null;
  state.settled = true;
  state.nodexAct.mockClear();
  state.candidates = [];
  state.scanning = false;
  state.run.mockClear();
  state.imports.mockClear();
  state.ensureFolder.mockClear();
  state.chooseFolders.mockReset();
  state.chooseFolders.mockResolvedValue([]);
});

describe("Connect your agents", () => {
  const unconnected: FirstRunAgentRow = {
    id: "codex",
    slot: "codex",
    mark: { kind: "agent", driver: "codex" },
    label: "Codex",
    detail: "Sign in with your ChatGPT account",
    state: "action",
    found: false,
    action: { kind: "browser-sign-in", label: "Sign in" },
  };

  it("doesn't call the way forward agentless while the Agents are still answering", () => {
    state.anyReady = false;
    state.settled = false;
    state.agents = [{ ...unconnected, detail: "Checking…", state: "checking", action: null }];
    setup();

    expect(isDisabled(primary("Continue"))).toBe(false);
    expect(screen.queryByRole("button", { name: "Continue without an agent" })).toBeNull();
  });

  it("gives Enter to the way forward only once there's an Agent to go forward with", () => {
    state.anyReady = false;
    state.agents = [unconnected];
    setup();
    expect(document.activeElement).not.toBe(primary("Continue without an agent"));

    state.anyReady = true;
    state.agents = [readyAgent];
    act(() => rerender());
    expect(document.activeElement).toBe(primary("Continue"));
  });

  it("steps aside for Settings without finishing, so the projects step still follows", async () => {
    state.agents = [
      readyAgent,
      {
        id: "antigravity",
        slot: "antigravity",
        mark: { kind: "agent", driver: "antigravity" },
        label: "Antigravity",
        detail: "Antigravity needs 1.5.0 or newer",
        state: "action",
        found: true,
        action: {
          kind: "agent-settings",
          label: "Settings",
          binding: { driver: "antigravity", instanceId: "antigravity_work" },
        },
      },
    ];
    const { beginClosing, stepAsideForSettings, onOpenSettings } = setup();
    await click(primary("Settings"));

    expect(stepAsideForSettings).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledWith(
      expect.stringMatching(/^\/settings\/agent#.*antigravity_work/u),
    );
    expect(beginClosing).not.toHaveBeenCalled();
    expect(state.current).toMatchObject({ done: false, step: "agents" });
  });

  it("previews Claude Code's installer and runs it only when asked", async () => {
    state.agents = [
      {
        id: "claude",
        slot: "claude",
        mark: { kind: "agent", driver: "claudeAgent" },
        label: "Claude Code",
        detail: "Install Claude Code, then sign in",
        state: "action",
        found: false,
        action: { kind: "terminal-install", label: "Install" },
      },
    ];
    setup();
    await click(primary("Install"));
    expect(screen.getByText(/install\.sh/u)).toBeTruthy();
    expect(screen.queryByTestId("terminal")).toBeNull();
    await click(primary("Run"));
    expect(screen.getByTestId("terminal")).toBeTruthy();
  });
});

describe("Where should agents work?", () => {
  beforeEach(() => {
    state.current = { ...state.current!, step: "projects" };
  });

  it("selects active repositories and creates nothing before the person confirms", async () => {
    state.candidates = [candidate("/code/active"), candidate("/code/quiet", { suggested: false })];
    const { onStartNewChatWithPrompt } = setup();

    expect(isChecked(screen.getByRole("checkbox", { name: "active" }))).toBe(true);
    expect(isChecked(screen.getByRole("checkbox", { name: "quiet" }))).toBe(false);
    expect(state.ensureFolder).not.toHaveBeenCalled();

    await click(screen.getByRole("checkbox", { name: "quiet" }));
    await click(primary("Add 2 projects"));
    await waitFor(() => expect(state.ensureFolder).toHaveBeenCalledTimes(2));
    expect(state.ensureFolder).toHaveBeenCalledWith("/code/active");
    await waitFor(() => expect(state.current?.done).toBe(true));
    expect(onStartNewChatWithPrompt).toHaveBeenCalledWith({
      projectId: "created:active",
      prompt: firstTaskPrompt("existing-folder", null),
    });
  });

  it("brings recent chats only when asked", async () => {
    const chat = {
      backendKind: "codex" as const,
      nativeHome: "/home/.codex",
      nativeSessionId: "s",
      title: "t",
      cwd: "/code/a",
      updatedAt: 1,
    };
    state.candidates = [candidate("/code/a", { recentChats: [chat] })];
    setup();
    const bring = screen.getByRole("checkbox", { name: "Also bring recent chats" });
    expect(isChecked(bring)).toBe(false);
    await click(bring);
    await click(primary("Add project"));
    await waitFor(() => expect(state.imports).toHaveBeenCalledWith([chat]));
  });

  it("prepares New Chat before setup closes", async () => {
    const order: string[] = [];
    state.candidates = [candidate("/code/a")];
    setup({
      onStartNewChatWithPrompt: vi.fn(async () => {
        order.push(`done:${String(state.current?.done)}`);
      }),
    });
    await click(primary("Add project"));
    await waitFor(() => expect(state.current?.done).toBe(true));
    expect(order).toEqual(["done:false"]);
  });
});
