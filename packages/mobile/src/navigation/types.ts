import type { InboxMessage } from "@nodex/mobile-protocol";
import { useNavigation } from "@react-navigation/native";
import type {
  NativeStackNavigationProp,
  NativeStackScreenProps,
} from "@react-navigation/native-stack";

export type RootStack = {
  Welcome: { readonly uri?: string } | undefined;
  Home: undefined;
  Pair: { readonly uri?: string } | undefined;
  Chat: { readonly sessionId: string; readonly title?: string };
  Message: { readonly pageId: string; readonly initial?: InboxMessage };
  Suggestion: { readonly pageId: string; readonly initial?: InboxMessage };
  ChatItem: { readonly sessionId: string; readonly itemId: string };
  ScopePicker: undefined;
  /** `projectOnly` when what is being started has no choice of where to run. */
  ProjectPicker: { readonly projectOnly?: boolean } | undefined;
  AgentPicker: undefined;
  Settings: undefined;
};

export type ScreenProps<Name extends keyof RootStack> = NativeStackScreenProps<RootStack, Name>;

export const useRootNavigation = () => useNavigation<NativeStackNavigationProp<RootStack>>();
