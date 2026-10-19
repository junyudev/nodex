import { readComposerEnterBehavior } from "./composer-enter-behavior";
import { appScope, scopedAtomWithInitializer } from "./maitai";

/** The app-wide Enter preference, shared by the Composer and inline message editors. */
export const composerEnterBehaviorAtom = scopedAtomWithInitializer(
  appScope,
  readComposerEnterBehavior,
  { debugLabel: "composer-enter-behavior" },
);
