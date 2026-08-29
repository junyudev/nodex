import type { Meta, StoryObj } from "@storybook/react-vite";
import { fireEvent, getByRole, waitFor } from "@testing-library/dom";
import type { ManagedWorktreeRecord, ManagedWorktreeSettings } from "@/lib/types";
import { NodexSettingsPageSurface } from "@/components/ui/settings";
import {
  ManagedWorktreesSettingControl,
  type ManagedWorktreesSettingsService,
} from "./managed-worktrees-settings-control";

const DEFAULT_SETTINGS: ManagedWorktreeSettings = {
  worktreeRoot: null,
  autoDeleteEnabled: true,
  autoDeleteLimit: 15,
};

const WORKTREES: ManagedWorktreeRecord[] = [
  {
    hostId: "local",
    path: "/Users/asc/.codex/worktrees/a1b2/nodex",
    exists: true,
    repositoryPath: "/Users/asc/repo/nodex",
    createdAtMs: Date.now() - 60_000,
    conversations: [
      {
        threadId: "thread-one",
        projectId: "project-one",
        projectName: "Nodex",
        sessionId: "session-one",
        sessionTitle: "Fix worktree restore",
        threadName: "Fix worktree restore",
        archived: false,
        updatedAt: Date.now(),
      },
      {
        threadId: "thread-two",
        projectId: "project-one",
        projectName: "Nodex",
        sessionId: "session-two",
        sessionTitle: "Audit cleanup",
        threadName: "Audit cleanup",
        archived: true,
        updatedAt: Date.now() - 5_000,
      },
    ],
  },
  {
    hostId: "ssh:build-box",
    path: "/srv/codex/worktrees/c3d4/api",
    exists: true,
    repositoryPath: "/srv/repos/api",
    createdAtMs: Date.now() - 120_000,
    conversations: [],
  },
];

function service(input?: {
  settings?: ManagedWorktreeSettings;
  worktrees?: ManagedWorktreeRecord[];
  error?: boolean;
  pending?: boolean;
}): ManagedWorktreesSettingsService {
  let settings = input?.settings ?? DEFAULT_SETTINGS;
  const waitForever = new Promise<never>(() => undefined);
  return {
    getExecutionHosts: async () => ({ sshHosts: [] }),
    getSettings: async () => {
      if (input?.pending) return await waitForever;
      if (input?.error) throw new Error("offline");
      return settings;
    },
    updateSettings: async (patch) => {
      settings = { ...settings, ...patch };
      return settings;
    },
    list: async () => {
      if (input?.pending) return await waitForever;
      if (input?.error) throw new Error("offline");
      return input?.worktrees ?? WORKTREES;
    },
    delete: async () => true,
  };
}

const meta = {
  title: "Workbench/Settings/Managed worktrees",
  component: ManagedWorktreesSettingControl,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[808px] max-w-[calc(100vw-32px)]">
        <NodexSettingsPageSurface title="Worktrees">
          <Story />
        </NodexSettingsPageSurface>
      </div>
    ),
  ],
  args: { open: true },
} satisfies Meta<typeof ManagedWorktreesSettingControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleRepositoriesAndRemote: Story = {
  args: { service: service() },
};

export const CustomRootAndCleanupDisabled: Story = {
  args: {
    service: service({
      settings: {
        worktreeRoot: "/Volumes/Worktrees",
        autoDeleteEnabled: false,
        autoDeleteLimit: 30,
      },
      worktrees: WORKTREES.slice(0, 1),
    }),
  },
};

export const Empty: Story = {
  args: { service: service({ worktrees: [] }) },
};

export const Loading: Story = {
  args: { service: service({ pending: true }) },
};

export const LoadError: Story = {
  args: { service: service({ error: true }) },
};

export const DisableConfirmation: Story = {
  args: { service: service() },
  play: async ({ canvasElement }) => {
    const toggle = await waitFor(() =>
      getByRole(canvasElement, "switch", {
        name: "Automatically delete old worktrees",
      }),
    );
    fireEvent.click(toggle);
    await waitFor(() =>
      getByRole(document.body, "dialog", {
        name: "Disable automatic worktree deletion?",
      }),
    );
  },
};
