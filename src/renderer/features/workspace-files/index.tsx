import { lazy, type ComponentProps } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";

const WorkspaceFilesPanelView = lazy(async () => ({
  default: (await import("./workspace-files-panel")).WorkspaceFilesPanel,
}));

export function WorkspaceFilesPanel(props: ComponentProps<typeof WorkspaceFilesPanelView>) {
  return (
    <ApplicationSurface>
      <WorkspaceFilesPanelView {...props} />
    </ApplicationSurface>
  );
}

export { decideWorkspaceFileTabOpen, type WorkspaceFileOpenMode } from "./workspace-file-tab-model";
export {
  getWorkspaceFileDomTabId,
  getWorkspaceFileName,
  isWorkspacePathInsideRoot,
  resolveWorkspaceFilePresentation,
  resolveWorkspaceSourceLanguage,
  WORKSPACE_TEXT_EDITABLE_MAX_BYTES,
  WORKSPACE_TEXT_LOAD_MAX_BYTES,
} from "./workspace-file-model";
export type {
  WorkspaceFilesDraftState,
  WorkspaceFilesTab,
  WorkspaceFilesTabState,
} from "./workspace-file-types";
