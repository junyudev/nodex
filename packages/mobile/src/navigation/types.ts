import type { InboxEntry } from "@nodex/mobile-protocol";
import { createNavigationContainerRef, useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";

/** A chat picture as the full-screen viewer receives it: only what it reads and names. */
export type GalleryImage = { readonly ref: string; readonly name: string };

export type RootStack = {
  Welcome: { readonly uri?: string } | undefined;
  Home: undefined;
  Pair: { readonly uri?: string } | undefined;
  Chat: { readonly sessionId: string; readonly title?: string };
  Message: {
    readonly pageId: string;
    readonly initial?: InboxEntry;
    /** A chat this message is starting; the screen opens it once its host has started it. */
    readonly openChat?: string;
  };
  Suggestion: { readonly pageId: string; readonly initial?: InboxEntry };
  ChatItem: { readonly sessionId: string; readonly itemId: string };
  /** A message's or step's pictures, full screen, opened at one of them. */
  Images: { readonly images: readonly GalleryImage[]; readonly index: number };
  ScopePicker: undefined;
  /** `projectOnly` when what is being started has no choice of where to run. */
  ProjectPicker: { readonly projectOnly?: boolean } | undefined;
  AgentPicker: undefined;
  Settings: undefined;
};

export type ScreenProps<Name extends keyof RootStack> = NativeStackScreenProps<RootStack, Name>;

export const useRootNavigation = () => useNavigation<NativeStackNavigationProp<RootStack>>();

/**
 * The app's one navigation container. Switching Spaces remounts the stack inside it, so work that
 * outlives one screen instance, such as linking a Space, navigates through this instead.
 */
export const navigationRef = createNavigationContainerRef<RootStack>();
