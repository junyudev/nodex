import {
  NodexDropdownItem,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { PluginAppLogo } from "@/features/plugins/view/plugin-logo";
import { usePluginAppEntries } from "@/lib/plugin-app-adapter";
import {
  selectPluginAppEntries,
  type PluginAppBinding,
} from "../../../shared/agent-plugins/app-entrypoints";

export function WorkbenchThreadAppMenu({
  projectId,
  sessionId,
  onOpen,
}: {
  readonly projectId: string | null;
  readonly sessionId: string;
  readonly onOpen: (binding: Extract<PluginAppBinding, { kind: "thread" }>) => void;
}) {
  const entries = selectPluginAppEntries(usePluginAppEntries(projectId), { kind: "thread" });
  if (!entries.length) return null;
  return (
    <>
      <NodexDropdownSeparator />
      <NodexDropdownSectionLabel>Apps</NodexDropdownSectionLabel>
      {entries.map(({ pluginId, entry, ...presentation }) => (
        <NodexDropdownItem
          key={JSON.stringify([pluginId, entry.id])}
          leftSlot={<PluginAppLogo presentation={presentation} className="icon-xs" />}
          onSelect={() =>
            onOpen({
              kind: "thread",
              projectId,
              sessionId,
              pluginId,
              entryId: entry.id,
              presentation,
            })
          }
        >
          {entry.title}
        </NodexDropdownItem>
      ))}
    </>
  );
}
