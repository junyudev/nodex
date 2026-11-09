import { resolveFileResourceIcon } from "@/components/shared/file-resource-icon";
import type { ComponentType } from "react";
import { ImageEditorTabIcon, InboxIcon, ChatIcon } from "@/components/shared/icons";
import type { WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
import { getPanelNewTabAction } from "./workbench-panel-actions";

export interface WorkbenchSceneTabPresentation {
  readonly title: string;
  readonly icon?: ComponentType<{ className?: string }>;
}

export function resolveWorkbenchSceneTabPresentation(
  surface: WorkbenchSurfaceDescriptor,
): WorkbenchSceneTabPresentation {
  // A Project's Home is its own Inbox.
  if (surface.kind === "inbox") return { title: "Inbox", icon: InboxIcon };
  if (surface.kind === "conversation") {
    return { title: surface.titleSnapshot, icon: ChatIcon };
  }
  if (surface.kind === "image_editor") {
    return { title: surface.titleSnapshot, icon: ImageEditorTabIcon };
  }

  if (surface.kind === "page_file")
    return {
      title:
        surface.config.titleSnapshot ?? surface.config.logicalPath?.split("/").at(-1) ?? "File",
      icon: resolveFileResourceIcon(surface.config.logicalPath ?? surface.config.titleSnapshot),
    };
  const action = getPanelNewTabAction(surface.kind);
  return {
    title: surface.kind === "db_view" ? action.label : surface.titleSnapshot,
    icon: action.Icon,
  };
}
