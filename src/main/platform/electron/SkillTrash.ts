import * as Effect from "effect/Effect";
import { SkillFileError } from "../node/SkillFilesNode";
import type { ElectronDesktop } from "./ElectronDesktop";

export const trashSkillDirectory = (desktop: ElectronDesktop["Service"], directory: string) =>
  Effect.tryPromise({
    try: () => desktop.shell.trashItem(directory),
    catch: () => new SkillFileError("io", "The operating system could not trash this skill."),
  });
