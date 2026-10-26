import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { live as skillsLive } from "../../codex-application/StandaloneSkills";
import { nodeLive as gitLive } from "./GitCommandPlatformNode";

export const live = (options: Parameters<typeof skillsLive>[0]) =>
  skillsLive(options).pipe(Layer.provide(Layer.merge(gitLive, NodeServices.layer)));
