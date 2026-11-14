import { useQuery } from "@tanstack/react-query";
import { NodexButton } from "@/components/ui/button";
import { pluginAppCatalogOptions } from "@/lib/plugin-app-adapter";
import {
  pluginAppFileName,
  selectPluginAppEntries,
  type PluginAppBinding,
} from "../../../shared/agent-plugins/app-entrypoints";

export function WorkspaceFilePluginActions({
  projectId,
  path,
  hostId,
  onOpen,
}: {
  readonly projectId: string;
  readonly path: string;
  readonly hostId: string;
  readonly onOpen: (binding: Extract<PluginAppBinding, { kind: "file" }>, title: string) => void;
}) {
  const catalog = useQuery(pluginAppCatalogOptions(projectId));
  const name = pluginAppFileName(path);
  const choices = selectPluginAppEntries(catalog.data ?? [], { kind: "file", name });
  return choices.map(({ pluginId, entry, ...presentation }) => (
    <NodexButton
      key={pluginId}
      variant="ghostSecondary"
      size="sm"
      onClick={() =>
        onOpen(
          {
            kind: "file",
            projectId,
            pluginId,
            entryId: entry.id,
            file: { hostId, path },
            presentation,
          },
          name,
        )
      }
    >
      Open with {presentation.pluginName}
    </NodexButton>
  ));
}
