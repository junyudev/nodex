import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { RootNavigator } from "./navigation/RootNavigator";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { SnackbarHost } from "./ui/snackbar";

const COMPOSER_CLEARANCE = 84;

const Chrome = () => {
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-surface">
      <StatusBar />
      <RootNavigator />
      <SnackbarHost bottom={Math.max(insets.bottom, 8) + COMPOSER_CLEARANCE} />
    </View>
  );
};

export const Root = () => {
  // A launch hides this by itself, but a development reload shows it again and leaves it up.
  useEffect(() => SplashScreen.hide(), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <ErrorBoundary>
            <Chrome />
          </ErrorBoundary>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
};
