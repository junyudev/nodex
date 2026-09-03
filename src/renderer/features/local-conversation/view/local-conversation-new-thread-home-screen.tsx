import type { ReactNode } from "react";
import { motion } from "motion/react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { CODEX_SHELL_PANEL_TRANSITION } from "../../../lib/codex-panel-motion";
import {
  REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE,
  REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
  REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE,
} from "../../../../shared/remote-hosted-pip";
import { EnsureLocalConversationThreadScrollController } from "./local-conversation-thread-scroll-controller";

interface LocalConversationNewThreadHomeScreenProps {
  hero: ReactNode;
  footer: ReactNode;
  body?: ReactNode;
  floatingContent?: ReactNode;
  contentShiftX?: number;
}

export function LocalConversationNewThreadHomeScreen({
  hero,
  footer,
  body = null,
  floatingContent,
  contentShiftX = 0,
}: LocalConversationNewThreadHomeScreenProps) {
  const reducedMotion = useResolvedReducedMotion();

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-(--background)">
      {floatingContent}
      <EnsureLocalConversationThreadScrollController>
        <motion.div
          className="flex min-h-0 flex-1 flex-col"
          animate={{ x: contentShiftX }}
          transition={reducedMotion ? { duration: 0 } : CODEX_SHELL_PANEL_TRANSITION}
        >
          <div className="@container/left-panel relative flex h-full flex-col">
            <div
              className="[container-type:size] relative min-h-[43.75rem] w-full flex-1 overflow-y-auto [container-name:home-main-content]"
              role="main"
              data-new-thread-home-main="true"
              {...{
                [REMOTE_HOSTED_PIP_ANCHOR_HOST_ATTRIBUTE]: REMOTE_HOSTED_PIP_MAIN_THREAD_HOST_ID,
              }}
            >
              <div
                className="absolute top-[calc(50%-8rem)] left-1/2 flex w-[min(calc(100%-2.5rem),48rem)] min-w-0 -translate-x-1/2 flex-col items-center"
                data-new-thread-home-hero="true"
              >
                {hero}
              </div>
              <div
                className="absolute bottom-4 left-1/2 z-10 flex w-[min(calc(100%-2.5rem),46rem)] min-w-0 -translate-x-1/2 flex-col gap-2 electron:bg-token-main-surface-primary"
                data-new-thread-home-composer="true"
                {...{ [REMOTE_HOSTED_PIP_OBSTACLE_ATTRIBUTE]: "new-thread-home-composer" }}
              >
                {footer}
              </div>
              {body ? (
                <div className="absolute right-0 bottom-40 left-0 mx-auto max-h-[36%] w-[min(calc(100%-2.5rem),46rem)] min-w-0 overflow-y-auto pt-2">
                  {body}
                </div>
              ) : null}
            </div>
          </div>
        </motion.div>
      </EnsureLocalConversationThreadScrollController>
    </div>
  );
}
