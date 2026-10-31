import { readThreadQueueFollowUpsEnabled } from "./thread-composer-follow-up-mode";
import { appScope, scopedAtomWithInitializer } from "./maitai";

/** The app-wide Queue or Steer default for messages sent to a chat while it works. */
export const threadQueueFollowUpsEnabledAtom = scopedAtomWithInitializer(
  appScope,
  readThreadQueueFollowUpsEnabled,
  { debugLabel: "thread-queue-follow-ups-enabled" },
);
