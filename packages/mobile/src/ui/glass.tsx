import { BlurView } from "expo-blur";
import { GlassView, isGlassEffectAPIAvailable } from "expo-glass-effect";
import { Platform, StyleSheet, View, useColorScheme, type ViewProps } from "react-native";

import { useColor } from "./tokens";

/** Whether this system draws real Liquid Glass, and so lets content pass under its bars. */
export const LIQUID_GLASS = Platform.OS === "ios" && isGlassEffectAPIAvailable();

/** iOS's material. It stays behind the content, since touches can't reach views inside glass. */
const GlassBackdrop = ({ radius }: { readonly radius: number }) => {
  const dark = useColorScheme() === "dark";
  const tint = useColor("glass");
  const shape = [StyleSheet.absoluteFill, { borderRadius: radius }];
  return LIQUID_GLASS ? (
    <GlassView glassEffectStyle="regular" pointerEvents="none" style={shape} tintColor={tint} />
  ) : (
    <BlurView
      intensity={80}
      pointerEvents="none"
      style={[shape, { overflow: "hidden" }]}
      tint={dark ? "dark" : "light"}
    />
  );
};

/**
 * A control or card floating over content, in the nearest material the platform offers. Android's
 * is the view itself, since elevation on a backdrop would draw it over the content.
 */
export const Glass = ({
  radius,
  style,
  children,
  ...props
}: ViewProps & { readonly radius: number }) =>
  Platform.OS === "android" ? (
    <View
      {...props}
      className="border-[0.5px] border-line bg-surface-2"
      style={[{ borderRadius: radius, elevation: 4 }, style]}
    >
      {children}
    </View>
  ) : (
    <View {...props} style={[{ borderRadius: radius }, style]}>
      <GlassBackdrop radius={radius} />
      {children}
    </View>
  );
