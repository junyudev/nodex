import type { ComponentType } from "react";
import { MessageSquare } from "@/components/shared/icons/generic-icons";
import { ImageEditorTabIcon, InboxIcon } from "@/components/shared/icons";
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
    return { title: surface.titleSnapshot, icon: MessageSquare };
  }
  if (surface.kind === "image_editor") {
    return { title: surface.titleSnapshot, icon: ImageEditorTabIcon };
  }

  const action = getPanelNewTabAction(surface.kind);
  return {
    title: surface.kind === "db_view" ? action.label : surface.titleSnapshot,
    icon: action.Icon,
  };
}
