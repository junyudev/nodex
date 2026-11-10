import { makeWorkbenchSceneKey, type WorkbenchSceneOwner } from "../../../shared/workbench-scene";
import type { SkillFileController } from "./skill-file-controller";

const mounted = new Map<SkillFileController, { readonly surfaceKey?: string }>();

/** Keep pending writes reachable until they finish, even as a page leaves the render tree. */
export function mountSkillFile(controller: SkillFileController, surfaceKey?: string): () => void {
  const registration = { surfaceKey };
  mounted.set(controller, registration);
  return () => {
    void Promise.resolve().then(async () => {
      if (mounted.get(controller) !== registration) return;
      try {
        await controller.flush();
      } finally {
        if (mounted.get(controller) === registration) {
          mounted.delete(controller);
          controller.dispose();
        }
      }
    });
  };
}

export async function flushSkillFiles(surfaceKey?: string): Promise<boolean> {
  const results = await Promise.allSettled(
    [...mounted].flatMap(([controller, registration]) =>
      surfaceKey === undefined || registration.surfaceKey === surfaceKey
        ? [controller.flush()]
        : [],
    ),
  );
  return results.every((result) => result.status === "fulfilled" && result.value);
}

export function workbenchSkillSurfaceKey(owner: WorkbenchSceneOwner, surfaceId: string): string {
  return JSON.stringify([makeWorkbenchSceneKey(owner), surfaceId]);
}
