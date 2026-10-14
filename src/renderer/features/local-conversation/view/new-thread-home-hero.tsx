import { NodexHomeMark } from "@/components/ui/nodex-home-mark";
import type { ThreadStageActions, ThreadStageRouteInput } from "../thread-stage-types";
import { NewChatProjectSelector } from "./composer/new-chat-project-selector";

export function NewThreadHomeHero({
  actions,
  projectName,
  projectSelector,
}: {
  actions: ThreadStageActions;
  projectName: string;
  projectSelector: ThreadStageRouteInput["newThreadProjectSelector"];
}) {
  return (
    <div className="flex min-h-29 w-full flex-col items-center justify-end gap-6 select-none">
      <NodexHomeMark />
      <div className="heading-xl flex max-w-full min-w-0 items-end justify-center text-center font-sans leading-9 font-normal tracking-normal whitespace-pre-wrap text-token-foreground">
        <span className="inline-block max-w-full">
          {"What should we build in "}
          {projectSelector ? (
            <NewChatProjectSelector model={projectSelector} actions={actions} variant="heading" />
          ) : (
            <>{projectName}?</>
          )}
        </span>
      </div>
    </div>
  );
}
