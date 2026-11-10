import * as Effect from "effect/Effect";
import { ElectronDesktop } from "../electron/ElectronDesktop";
import { trashSkillDirectory } from "../electron/SkillTrash";
import { SkillFileMutationLane } from "../../host-runtime/SkillFileMutationLane";
import * as NodeServices from "./NodeServices";
import * as Layer from "effect/Layer";
import { live as skillsLive } from "../../codex-application/StandaloneSkills";
import { nodeLive as gitLive } from "./GitCommandPlatformNode";

export const live = (options: Parameters<typeof skillsLive>[0]) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const desktop = yield* ElectronDesktop;
      const fileLane = yield* SkillFileMutationLane;
      return skillsLive({
        ...options,
        fileLane,
        trashDirectory: (directory) => trashSkillDirectory(desktop, directory),
      });
    }),
  ).pipe(Layer.provide(Layer.merge(gitLive, NodeServices.layer)));
