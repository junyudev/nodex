import { lazy, type ComponentType } from "react";
import type { ConversationVideoPlayerProps } from "./conversation-video-player";

type VideoModule = {
  readonly ConversationVideoPlayer: ComponentType<ConversationVideoPlayerProps>;
};

function UnavailableVideo({ loadErrorFallback }: ConversationVideoPlayerProps) {
  return loadErrorFallback;
}

/** One lazy type shares its code load across consumers; failure gets one bounded retry. */
export function createLazyConversationVideoPlayer(load: () => Promise<VideoModule>) {
  return lazy(async () => {
    try {
      return { default: (await load()).ConversationVideoPlayer };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    try {
      return { default: (await load()).ConversationVideoPlayer };
    } catch (error) {
      console.error("Unable to load video player", error);
      return { default: UnavailableVideo };
    }
  });
}

export const LazyConversationVideoPlayer = createLazyConversationVideoPlayer(
  () => import("./conversation-video-player"),
);
