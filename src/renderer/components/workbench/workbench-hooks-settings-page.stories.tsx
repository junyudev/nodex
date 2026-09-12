import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { HookMetadata } from "@nodex/codex-app-server-protocol/v2/HookMetadata";
import type { HooksListEntry } from "@nodex/codex-app-server-protocol/v2/HooksListEntry";
import {
  CodexHooksSettingsView,
  type CodexHooksSettingsViewProps,
} from "./workbench-hooks-settings-page";

type CommandHookMetadata = Extract<HookMetadata, { handlerType: "command" }>;

function hook(
  overrides: Partial<CommandHookMetadata> & Pick<CommandHookMetadata, "key" | "source">,
): CommandHookMetadata {
  return {
    eventName: "stop",
    handlerType: "command",
    matcher: null,
    command: "pnpm test",
    async: false,
    timeoutSec: 30n,
    statusMessage: "Checking the workspace",
    sourcePath: "/Users/asc/repo/nodex/.codex/hooks.json",
    pluginId: null,
    displayOrder: 0n,
    enabled: true,
    isManaged: false,
    currentHash: "current-hash",
    trustStatus: "trusted",
    ...overrides,
    additionalContextLimit: overrides.additionalContextLimit ?? null,
  };
}

const ENTRIES: HooksListEntry[] = [
  {
    cwd: "/Users/asc/repo/nodex",
    hooks: [
      hook({ key: "user-stop", source: "user" }),
      hook({
        key: "admin-permission",
        source: "cloudManagedConfig",
        eventName: "permissionRequest",
        trustStatus: "managed",
        isManaged: true,
      }),
      hook({
        key: "project-review",
        source: "project",
        eventName: "postToolUse",
        trustStatus: "modified",
      }),
      hook({ key: "plugin-format", source: "plugin", pluginId: "workspace-tools@1.2.0" }),
      hook({ key: "plugin-unknown", source: "plugin", pluginId: null, enabled: false }),
    ],
    warnings: ["One legacy hook matcher was ignored"],
    errors: [],
  },
];

function HooksStory(props: Partial<CodexHooksSettingsViewProps> & { initialPath?: string }) {
  const [path, setPath] = useState(props.initialPath ?? "/settings/hooks-settings?hostId=local");

  return (
    <div className="h-screen bg-token-main-surface-primary">
      <CodexHooksSettingsView
        entries={ENTRIES}
        hostId="local"
        path={path}
        projectRoots={["/Users/asc/repo/nodex"]}
        projectRootLabels={{ "/Users/asc/repo/nodex": "Nodex" }}
        loading={false}
        refreshing={false}
        loadError={null}
        onPathChange={setPath}
        onRefresh={() => undefined}
        onToggle={() => undefined}
        onTrust={() => undefined}
        {...props}
      />
    </div>
  );
}

const meta = {
  title: "Workbench/Settings/Hooks",
  component: HooksStory,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HooksStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {
  render: () => <HooksStory />,
};

export const ProjectNeedsReview: Story = {
  render: () => (
    <HooksStory initialPath="/settings/hooks-settings?hostId=local&source=project&projectRoot=%2FUsers%2Fasc%2Frepo%2Fnodex" />
  ),
};

export const Loading: Story = {
  render: () => <HooksStory entries={null} loading />,
};

export const LoadError: Story = {
  render: () => <HooksStory entries={null} loadError={new Error("Codex host is unavailable")} />,
};
