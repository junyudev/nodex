import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class SkillFileMutationLane extends Context.Service<
  SkillFileMutationLane,
  Semaphore.Semaphore
>()("nodex/main/host-runtime/SkillFileMutationLane") {
  static readonly live = Layer.effect(this, Semaphore.make(1));
}
