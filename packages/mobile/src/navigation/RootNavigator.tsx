import { parsePairingUri } from "@nodex/mobile-protocol";
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
  createNavigationContainerRef,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  type NativeStackNavigationOptions,
} from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { useEffect, useState } from "react";
import { Platform, useColorScheme } from "react-native";

import { ChatItemScreen } from "../features/chat/ChatItemScreen";
import { ChatScreen } from "../features/chat/ChatScreen";
import { HOME_HEADER, HomeScreen } from "../features/home/HomeScreen";
import { MessageScreen } from "../features/inbox/MessageScreen";
import { SuggestionScreen } from "../features/inbox/Suggestion";
import { PairScreen } from "../features/pair/PairScreen";
import {
  AgentPickerScreen,
  ProjectPickerScreen,
  ScopePickerScreen,
} from "../features/pickers/PickerScreens";
import { SettingsScreen } from "../features/settings/SettingsScreen";
import { activateHost, useHosts } from "../runtime";
import { useNotificationRouting } from "../features/notifications/notification-routing";
import { LIQUID_GLASS } from "../ui/glass";
import { IconButton } from "../ui/primitives";
import { useColor } from "../ui/tokens";
import type { RootStack } from "./types";

const Stack = createNativeStackNavigator<RootStack>();
const navigationRef = createNavigationContainerRef<RootStack>();

const SHEET: NativeStackNavigationOptions = {
  presentation: "formSheet",
  sheetAllowedDetents: [0.5, 0.92],
  sheetGrabberVisible: true,
  headerShown: false,
  // Clear content is what lets the system draw a partial sheet as glass.
  ...(LIQUID_GLASS ? { contentStyle: { backgroundColor: "transparent" } } : {}),
  ...(Platform.OS === "android" ? { sheetCornerRadius: 28 } : {}),
};

/** A bar the system draws as glass with content passing beneath it, where it can. */
const GLASS_BAR: NativeStackNavigationOptions = LIQUID_GLASS
  ? {
      headerTransparent: true,
      headerStyle: { backgroundColor: "transparent" },
      scrollEdgeEffects: { top: "automatic", bottom: "hidden", left: "hidden", right: "hidden" },
    }
  : {};

/**
 * A pairing code scanned with the system camera opens the app on the screen that pairs. The link
 * may be what launched the app, so it waits for navigation to be ready rather than being dropped.
 */
const useIncomingPairing = (ready: boolean) => {
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (!ready || !url) return;
    // The system can hand back the link that first launched the app; only a live code acts.
    const offer = parsePairingUri(url);
    if (!offer || offer.expiresAt <= Date.now()) return;
    const paired = navigationRef.getRootState()?.routeNames.includes("Pair");
    navigationRef.navigate(paired ? "Pair" : "Welcome", { uri: url });
  }, [ready, url]);
};

export const RootNavigator = () => {
  const { hosts } = useHosts();
  const scheme = useColorScheme();
  const background = useColor("surface");
  const ink = useColor("ink");
  const [ready, setReady] = useState(false);
  const paired = hosts.length > 0;
  useIncomingPairing(ready);
  useNotificationRouting(ready && paired, ({ sessionId, hostId }) => {
    if (hostId) activateHost(hostId);
    navigationRef.navigate("Chat", { sessionId });
  });
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, background, card: background, text: ink, primary: ink },
  };
  return (
    <NavigationContainer ref={navigationRef} onReady={() => setReady(true)} theme={theme}>
      <Stack.Navigator
        screenOptions={{
          contentStyle: { backgroundColor: background },
          headerBackButtonDisplayMode: "minimal",
          headerTitleAlign: "center",
          headerShadowVisible: false,
          headerTintColor: ink,
          headerStyle: { backgroundColor: background },
          ...GLASS_BAR,
        }}
      >
        {paired ? (
          <>
            <Stack.Screen name="Home" component={HomeScreen} options={HOME_HEADER} />
            <Stack.Screen name="Chat" component={ChatScreen} />
            <Stack.Screen name="Message" component={MessageScreen} options={{ title: "" }} />
            <Stack.Screen name="ChatItem" component={ChatItemScreen} options={{ title: "" }} />
            <Stack.Screen
              name="Suggestion"
              component={SuggestionScreen}
              options={{ ...SHEET, sheetAllowedDetents: "fitToContents" }}
            />
            <Stack.Screen name="ScopePicker" component={ScopePickerScreen} options={SHEET} />
            <Stack.Screen name="ProjectPicker" component={ProjectPickerScreen} options={SHEET} />
            <Stack.Screen name="AgentPicker" component={AgentPickerScreen} options={SHEET} />
            <Stack.Screen
              name="Settings"
              component={SettingsScreen}
              options={({ navigation }) => ({
                title: "Settings",
                presentation: "modal",
                ...(Platform.OS === "ios"
                  ? {
                      headerRight: () => (
                        <IconButton
                          color="ink"
                          label="Close"
                          name="close"
                          onPress={() => navigation.goBack()}
                        />
                      ),
                    }
                  : {}),
              })}
            />
            <Stack.Screen
              name="Pair"
              component={PairScreen}
              options={{ headerShown: false, presentation: "modal" }}
            />
          </>
        ) : (
          // Its own name: becoming paired replaces this screen with Home instead of keeping it.
          <Stack.Screen name="Welcome" component={PairScreen} options={{ headerShown: false }} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
};
