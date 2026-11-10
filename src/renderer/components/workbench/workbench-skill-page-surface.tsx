import { useContext } from "react";
import { SkillNavigationContext } from "@/features/skills/open-skill";
import { SkillPage } from "@/features/skills/view/skill-page";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { workbenchSkillSurfaceKey } from "@/features/skills/skill-file-lifecycle";
import type { WorkbenchSkillSurfaceConfig } from "../../../shared/schemas/workbench-skill";
import {
  makeWorkbenchSceneKey,
  updateWorkbenchSceneSurface,
  type WorkbenchSceneOwner,
} from "../../../shared/workbench-scene";

export function WorkbenchSkillPageSurface({
  sceneOwner,
  surfaceId,
  config,
  onClose,
}: {
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly config: WorkbenchSkillSurfaceConfig;
  readonly onClose: () => void;
}) {
  const windowOwner = useWorkbenchWindowOwner();
  const navigation = useContext(SkillNavigationContext);
  const { hostId, projectId, skillId } = config;
  const context = { hostId, projectId };
  const update = (
    nextId: string,
    metadata?: { readonly name: string; readonly manifestPath: string },
  ) => {
    const scene =
      windowOwner.read().windowState.scenesByOwnerKey[makeWorkbenchSceneKey(sceneOwner)];
    const current = scene?.panelSurfacesById[surfaceId];
    if (!scene || current?.kind !== "skill" || current.config.skillId !== skillId) return;
    const titleSnapshot = metadata?.name ?? current.titleSnapshot;
    const manifestPath = metadata?.manifestPath ?? null;
    if (
      nextId === skillId &&
      titleSnapshot === current.titleSnapshot &&
      manifestPath === current.config.manifestPath
    )
      return;
    windowOwner.setScene(
      sceneOwner,
      updateWorkbenchSceneSurface(scene, surfaceId, {
        titleSnapshot,
        config: { hostId, projectId, skillId: nextId, manifestPath },
      }),
      { recordHistory: false },
    );
  };
  return (
    <SkillPage
      context={context}
      skillId={skillId}
      surfaceKey={workbenchSkillSurfaceKey(sceneOwner, surfaceId)}
      onMetadataChange={(skill) => update(skillId, skill)}
      onOpenSkill={(nextId) => update(nextId)}
      onClose={onClose}
      onTry={navigation ? (skill) => navigation.trySkill(context, skill) : undefined}
    />
  );
}
