import { ChatIcon } from "@/components/shared/icons";
import { MentionInlineVisual, type MentionInlineVisualProps } from "./mention-inline-visual";

export type ThreadMentionInlineVisualProps = MentionInlineVisualProps & {
  readonly withGuards?: boolean;
};

export function ThreadMentionInlineVisual(props: ThreadMentionInlineVisualProps) {
  return (
    <MentionInlineVisual
      {...props}
      kind="thread"
      icon={props.icon ?? <ChatIcon className="size-full" />}
    />
  );
}
