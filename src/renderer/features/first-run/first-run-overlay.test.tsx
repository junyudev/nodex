import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Project, ProjectCreateInput } from "@/lib/types";
import type { ProjectCandidate } from "../../../shared/project-discovery";
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
  settled: true,
  nodexAct: vi.fn(),
  candidates: [] as ProjectCandidate[],
  scanning: false,
  run: vi.fn(),
  imports: vi.fn(),
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
    useCodexApiKey: vi.fn(),
  }),
}));
vi.mock("./first-run-projects", () => ({
  chooseProjectFolders: state.chooseFolders,
  importRecentChats: state.imports,
  useChatImportProgress: () => null,
  useProjectCandidates: () => ({
    data: { candidates: state.candidates, truncated: false },
    isPending: state.scanning,
  }),
}));
vi.mock("./first-run-terminal", () => ({
  claudeInstallPreview: () => "curl -fsSL https://claude.ai/install.sh | bash",
  resolveClaudeSignInCommand: async () => "claude auth login",
  runSetupTerminal: () => () => undefined,
}));
vi.mock("@/components/board/terminal-panel", () => ({
  TerminalPanel: () => <div data-testid="terminal" />,
}));

let rerender: () => void = () => undefined;
let finished: () => void = () => undefined;

const project = (id: string, path: string): Project =>
  ({ id, name: id, sources: [{ kind: "directory", path, order: 0 }] }) as unknown as Project;

const candidate = (path: string, overrides: Partial<ProjectCandidate> = {}): ProjectCandidate => ({
  path,
  displayPath: path,
  name: path.split("/").at(-1)!,
  repository: null,
  isGitRepository: true,
  chatCount: 4,
  lastActiveAt: Date.now(),
  suggested: true,
  recentChats: [],
  ...overrides,
});

function setup(overrides: Partial<FirstRunOverlayProps> = {}) {
  const beginClosing = vi.fn();
  const onStartNewChatWithPrompt = vi.fn(async () => undefined);
  const onStartNewChat = vi.fn(async () => undefined);
  const onCreateProject = vi.fn(async (input: ProjectCreateInput) =>
    project(`created:${input.name}`, input.sources?.[0] ?? ""),
  );
  let props: FirstRunOverlayProps = {
    presentation: { undecided: false, showing: true, workbenchInert: true, beginClosing },
    projects: [],
    insets: { left: 92, right: 12 },
    onCreateProject,
    onStartNewChatWithPrompt,
    onStartNewChat,
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
  };
}

const readyAgent: FirstRunAgentRow = {
  id: "codex",
  label: "Codex",
  detail: "a@example.com",
  state: "ready",
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
  state.settled = true;
  state.nodexAct.mockClear();
  state.candidates = [];
  state.scanning = false;
  state.run.mockClear();
  state.imports.mockClear();
  state.chooseFolders.mockReset();
  state.chooseFolders.mockResolvedValue([]);
});

describe("Connect an agent", () => {
  const unconnected: FirstRunAgentRow = {
    id: "codex",
    label: "Codex",
    detail: "Sign in with your ChatGPT account",
    state: "action",
    action: { kind: "codex-sign-in", label: "Sign in" },
  };

  it("never stands in the way when no Agent is ready", async () => {
    state.anyReady = false;
    state.agents = [unconnected];
    setup();

    await click(primary("Sign in"));
    expect(state.run).toHaveBeenCalledWith("codex-sign-in");

    await click(primary("Continue without an agent"));
    expect(state.current?.step).toBe("projects");
  });

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

  it("can be skipped from the start", async () => {
    state.anyReady = false;
    state.agents = [unconnected];
    const { onStartNewChat, beginClosing } = setup();

    await click(primary("Skip"));
    await waitFor(() => expect(onStartNewChat).toHaveBeenCalledWith(null, { focusComposer: true }));
    expect(beginClosing).toHaveBeenCalled();
    await waitFor(() => expect(state.current?.done).toBe(true));
  });

  it("offers one thing to do when reopened to connect an Agent", () => {
    state.current = { ...INITIAL_FIRST_RUN_STATE, step: "agents", entry: "connect" };
    state.anyReady = false;
    state.agents = [unconnected];
    setup();

    expect(primary("Close")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Continue/u })).toBeNull();

    state.anyReady = true;
    state.agents = [readyAgent];
    act(() => rerender());
    expect(primary("Done")).toBeTruthy();
  });

  it("lays out top-ups under the Nodex row without holding anyone to them", async () => {
    state.anyReady = false;
    state.agents = [
      {
        id: "nodex",
        label: "Nodex credits",
        detail: "ada@example.com · No credits yet",
        state: "action",
        action: null,
        offersTopUp: true,
      },
    ];
    setup();

    await click(primary("Pay $10 for 275 credits"));
    expect(state.nodexAct).toHaveBeenCalledWith("openTopUp", 10);

    await click(primary("Continue without an agent"));
    expect(state.current?.step).toBe("projects");
  });

  it("previews Claude Code's installer and runs it only when asked", async () => {
    state.agents = [
      {
        id: "claude",
        label: "Claude Code",
        detail: "Install Claude Code, then sign in",
        state: "action",
        action: { kind: "claude-install", label: "Install" },
      },
    ];
    setup();
    await click(primary("Install"));
    expect(screen.getByText(/install\.sh/u)).toBeTruthy();
    expect(screen.queryByTestId("terminal")).toBeNull();
    await click(primary("Run"));
    expect(screen.getByTestId("terminal")).toBeTruthy();
  });

  it("opens a Terminal right away to sign in to Claude Code", async () => {
    state.agents = [
      {
        id: "claude",
        label: "Claude Code",
        detail: "Sign in with your Claude account",
        state: "action",
        action: { kind: "claude-sign-in", label: "Sign in" },
      },
    ];
    setup();
    await click(primary("Sign in"));
    expect(await screen.findByTestId("terminal")).toBeTruthy();
  });

  it("ends after this page when opened only to connect an Agent", async () => {
    state.current = { ...state.current!, entry: "connect" };
    const { onStartNewChat, onStartNewChatWithPrompt } = setup();
    await click(primary("Done"));
    await waitFor(() => expect(state.current?.done).toBe(true));
    expect(onStartNewChat).not.toHaveBeenCalled();
    expect(onStartNewChatWithPrompt).not.toHaveBeenCalled();
  });
});

describe("Where should agents work?", () => {
  beforeEach(() => {
    state.current = { ...state.current!, step: "projects" };
  });

  it("selects active repositories and creates nothing before the person confirms", async () => {
    state.candidates = [candidate("/code/active"), candidate("/code/quiet", { suggested: false })];
    const { onCreateProject, onStartNewChatWithPrompt } = setup();

    expect(isChecked(screen.getByRole("checkbox", { name: "active" }))).toBe(true);
    expect(isChecked(screen.getByRole("checkbox", { name: "quiet" }))).toBe(false);
    expect(onCreateProject).not.toHaveBeenCalled();

    await click(screen.getByRole("checkbox", { name: "quiet" }));
    await click(primary("Add 2 projects"));
    await waitFor(() => expect(onCreateProject).toHaveBeenCalledTimes(2));
    expect(onCreateProject).toHaveBeenCalledWith({ name: "active", sources: ["/code/active"] });
    await waitFor(() => expect(state.current?.done).toBe(true));
    expect(onStartNewChatWithPrompt).toHaveBeenCalledWith({
      projectId: "created:active",
      prompt: firstTaskPrompt("existing-folder"),
    });
  });

  it("doesn't offer a folder that's already a Project", () => {
    state.candidates = [candidate("/code/added"), candidate("/code/new")];
    setup({ projects: [project("p", "/code/added")] });
    expect(screen.queryByRole("checkbox", { name: "added" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "new" })).toBeTruthy();
  });

  it("adds a chosen folder as a selected row", async () => {
    state.chooseFolders.mockResolvedValue(["/elsewhere/tool"]);
    const { onCreateProject } = setup();
    await click(primary("Choose a folder"));
    expect(isChecked(await screen.findByRole("checkbox", { name: "tool" }))).toBe(true);
    await click(primary("Add project"));
    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith({ name: "tool", sources: ["/elsewhere/tool"] }),
    );
  });

  it("starts an empty project with no source, so Main makes its folder", async () => {
    const { onCreateProject, onStartNewChatWithPrompt } = setup();
    await click(primary("Start an empty project"));
    const name = screen.getByRole("textbox", { name: "Project name" });
    await act(async () => {
      fireEvent.change(name, { target: { value: "Sketches" } });
      fireEvent.submit(name.closest("form")!);
      await Promise.resolve();
    });
    await click(primary("Add project"));
    await waitFor(() =>
      expect(onCreateProject).toHaveBeenCalledWith({ name: "Sketches", sources: [] }),
    );
    await waitFor(() =>
      expect(onStartNewChatWithPrompt).toHaveBeenCalledWith({
        projectId: "created:Sketches",
        prompt: firstTaskPrompt("empty-folder"),
      }),
    );
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
    await waitFor(() =>
      expect(state.imports).toHaveBeenCalledWith([{ projectId: "created:a", chat }]),
    );
  });

  it("leaves chats alone by default", async () => {
    state.candidates = [
      candidate("/code/a", {
        recentChats: [
          {
            backendKind: "codex",
            nativeHome: "/h",
            nativeSessionId: "s",
            title: "t",
            cwd: "/code/a",
            updatedAt: 1,
          },
        ],
      }),
    ];
    setup();
    await click(primary("Add project"));
    await waitFor(() => expect(state.current?.done).toBe(true));
    expect(state.imports).not.toHaveBeenCalled();
  });

  it("can continue with no Project at all", async () => {
    const { onStartNewChatWithPrompt } = setup();
    expect(isDisabled(primary("Done"))).toBe(true);
    await click(primary("Just chat for now"));
    await waitFor(() =>
      expect(onStartNewChatWithPrompt).toHaveBeenCalledWith({
        projectId: null,
        prompt: firstTaskPrompt("no-project"),
      }),
    );
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

  it("stays where the person was when a replay added nothing", async () => {
    state.current = { ...state.current!, entry: "replay" };
    const { onStartNewChat, onStartNewChatWithPrompt } = setup({
      projects: [project("p", "/code/added")],
    });
    await click(primary("Done"));
    await waitFor(() => expect(state.current?.done).toBe(true));
    expect(onStartNewChat).not.toHaveBeenCalled();
    expect(onStartNewChatWithPrompt).not.toHaveBeenCalled();
  });

  it("goes back to the Agents page", async () => {
    setup();
    await click(primary("Back"));
    expect(state.current?.step).toBe("agents");
  });
});
