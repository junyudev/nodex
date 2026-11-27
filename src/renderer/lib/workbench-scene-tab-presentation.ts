import { getIntl, type IntlShape } from "@/lib/i18n";
import { PluginsIcon } from "@/components/shared/icons";
import { SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import { resolveFileResourceIcon } from "@/components/shared/file-resource-icon";
import type { ComponentType } from "react";
import { ImageEditorTabIcon, InboxIcon, ChatIcon } from "@/components/shared/icons";
import type { WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
import { getPanelNewTabAction } from "./workbench-panel-actions";
import {
  presentWorkbenchPanelTabTitle,
  type WorkbenchPanelTabTitleOptions,
} from "./workbench-panel-tab-title";

export interface WorkbenchSceneTabPresentation {
  readonly title: string;
  readonly icon?: ComponentType<{ className?: string }>;
}

export function resolveWorkbenchSceneTabPresentation(
  surface: WorkbenchSurfaceDescriptor,
  intl: IntlShape = getIntl(),
  titleOptions: WorkbenchPanelTabTitleOptions = { standardDatabaseTitle: true },
): WorkbenchSceneTabPresentation {
  const title = presentWorkbenchPanelTabTitle(surface, surface.titleSnapshot, intl, titleOptions);
  // A Project's Home is its own Inbox.
  if (surface.kind === "inbox") return { title, icon: InboxIcon };
  if (surface.kind === "conversation") {
    return { title, icon: ChatIcon };
  }
  if (surface.kind === "image_editor") {
    return { title, icon: ImageEditorTabIcon };
  }

  if (surface.kind === "github_thread") return { title };
  if (surface.kind === "plugin_app") return { title, icon: PluginsIcon };
  if (surface.kind === "skill") return { title, icon: SkillCubeIcon };
  if (surface.kind === "page_file")
    return {
      title,
      icon: resolveFileResourceIcon(surface.config.logicalPath ?? surface.config.titleSnapshot),
    };
  return { title, icon: getPanelNewTabAction(surface.kind).Icon };
}
