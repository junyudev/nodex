import { FormattedMessage } from "@/lib/i18n";
import { NodexHomeMark } from "@/components/ui/nodex-home-mark";
import { resolveSelectedNewChatProjectSelectorOption } from "@/lib/new-chat-project-selector";
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
  // The Composer's own project chip offers the choice, so the question stands on its own here.
  const inNoProject =
    projectSelector !== undefined &&
    projectSelector !== null &&
    !resolveSelectedNewChatProjectSelectorOption(
      projectSelector.projects,
      projectSelector.selectedProjectId,
    );
  return (
    <div className="flex min-h-29 w-full flex-col items-center justify-end gap-6 select-none">
      <NodexHomeMark />
      <div className="heading-xl flex max-w-full min-w-0 items-end justify-center text-center font-sans leading-9 font-normal tracking-normal whitespace-pre-wrap text-token-foreground">
        <span className="inline-block max-w-full">
          {inNoProject ? (
            <FormattedMessage
              id="conversation.newThreadHomeHero.heading"
              defaultMessage="What should we build?"
            />
          ) : projectSelector ? (
            <FormattedMessage
              id="conversation.newThreadHomeHero.headingWithProjectPicker"
              defaultMessage="What should we build in <project></project>?"
              values={{
                project: () => (
                  <NewChatProjectSelector
                    model={projectSelector}
                    actions={actions}
                    variant="heading"
                  />
                ),
              }}
            />
          ) : (
            <FormattedMessage
              id="conversation.newThreadHomeHero.headingWithProject"
              defaultMessage="What should we build in {project}?"
              values={{ project: projectName }}
            />
          )}
        </span>
      </div>
    </div>
  );
}
