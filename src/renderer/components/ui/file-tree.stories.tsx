import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { FileTree } from "./file-tree";
import { buildFileTreeExpandedPaths } from "@/lib/file-tree-paths";
import {
  fileTreeCommentIcon,
  fileTreeCommentSprite,
} from "@/components/shared/icons/file-tree-comment-decoration";

const entries = [
  { path: "../tools/research/THREAD_ACTIVITY.md", status: "modified" as const },
  { path: ".generated/thread-analysis.md", status: "modified" as const },
  { path: "src/main/agent/agent-service.ts", status: "modified" as const },
  {
    path: "src/renderer/features/local-conversation/local-conversation-store.ts",
    status: "modified" as const,
  },
  { path: "src/shared/conversation-state/reducer.ts", status: "modified" as const },
  { path: "src/shared/conversation-state/queue.ts", status: "added" as const },
  { path: "src/shared/conversation-state/removed.ts", status: "deleted" as const },
  { path: "src/shared/conversation-state/renamed.ts", status: "renamed" as const },
  { path: "src/shared/conversation-state/new.ts", status: "untracked" as const },
];
const paths = entries.map((entry) => entry.path);
const expandedPaths = buildFileTreeExpandedPaths(paths);
const meta = {
  title: "UI/File Tree",
  component: FileTree,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FileTree>;
export default meta;
type Story = StoryObj<typeof FileTree>;

function TreeFixture({
  comments = false,
  workspace = false,
}: {
  comments?: boolean;
  workspace?: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  return (
    <div className="h-[560px] w-[345px] bg-token-main-surface-primary px-2" data-file-tree-fixture>
      <FileTree
        appearance={workspace ? "workspace" : "review"}
        ariaLabel="Project files"
        paths={paths}
        gitStatus={workspace ? undefined : entries}
        expandedPaths={expandedPaths}
        selectedPath={selectedPath}
        flattenEmptyDirectories={!workspace}
        onSelectionChange={(selection) => setSelectedPath(selection[0] ?? null)}
        icons={
          comments
            ? { set: "complete", colored: true, spriteSheet: fileTreeCommentSprite([2, 12]) }
            : undefined
        }
        renderRowDecoration={
          comments
            ? ({ item }) =>
                item.kind === "file"
                  ? {
                      icon: fileTreeCommentIcon(item.path.endsWith("reducer.ts") ? 12 : 2),
                      title: "Comments",
                    }
                  : null
            : undefined
        }
      />
    </div>
  );
}
export const Review: Story = { render: () => <TreeFixture /> };
export const Comments: Story = { render: () => <TreeFixture comments /> };
export const Workspace: Story = { render: () => <TreeFixture workspace /> };
