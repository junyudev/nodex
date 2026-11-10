import { useIsFocused } from "@react-navigation/native";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { GestureDetector, usePanGesture, type PanGesture } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

import { softTap } from "./primitives";
import { draggedProgress, restsOpen, sideMenuWidth } from "./side-menu";
import { useColor } from "./tokens";

interface SideMenuControl {
  readonly isOpen: boolean;
  readonly open: () => void;
  readonly close: () => void;
  /** The drag that moves the menu, for a sideways scroller that must let it run beside its own. */
  readonly drag: PanGesture;
  readonly setSwipeOpens: (allowed: boolean) => void;
}

const SideMenuContext = createContext<SideMenuControl | null>(null);

export const useSideMenu = (): SideMenuControl => {
  const control = useContext(SideMenuContext);
  if (!control) throw new Error("The side menu is used outside the app it belongs to.");
  return control;
};

/**
 * The calling screen is where the menu belongs: while it is the one in front, a swipe to the right
 * across it opens the menu if `swipeOpens`, and leaving the screen closes the menu.
 */
export const useSideMenuScreen = (swipeOpens: boolean): void => {
  const { close, setSwipeOpens } = useSideMenu();
  const focused = useIsFocused();
  useEffect(() => {
    setSwipeOpens(focused && swipeOpens);
    return () => setSwipeOpens(false);
  }, [focused, setSwipeOpens, swipeOpens]);
  useEffect(() => {
    if (!focused) close();
    return close;
  }, [close, focused]);
};

// A worklet can ask for this by name, but cannot reach into the Keyboard module itself.
const dismissKeyboard = () => Keyboard.dismiss();

/** Quick and without bounce, so the app lands under the finger that let it go. */
const SPRING = { mass: 1, damping: 36, stiffness: 380, overshootClamping: true } as const;

/**
 * How far a finger travels sideways before the menu follows it, and how far off course ends it. Both
 * fall short of the distance at which a list starts to scroll, so a level drag is the menu's before
 * a list can take it, and from then on it is no longer a press on the row beneath.
 */
const DRAG_START = 8;
const DRAG_STRAY = 10;

/** The app's corners once it has moved aside, as a card resting on the menu. */
const CARD_RADIUS = 40;

/**
 * The app with a menu beneath it. Opening slides the whole app aside as a card, so everything on it
 * moves together, bars included, and what shows of it is a way back: tap it or drag it home.
 */
export const SideMenu = ({
  menu,
  children,
}: {
  readonly menu: ReactNode;
  readonly children: ReactNode;
}) => {
  const { width } = useWindowDimensions();
  const menuWidth = sideMenuWidth(width);
  const veil = useColor("surface");
  const edge = useColor("line");
  /** 0 with the app in place, 1 with the menu fully open. */
  const progress = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const [isOpen, setIsOpen] = useState(false);
  const [swipeOpens, setSwipeOpens] = useState(false);
  const wasOpen = useRef(false);

  const rest = useCallback((open: boolean) => {
    // Arriving is felt once, however it was opened; returning is silent.
    if (open && !wasOpen.current) softTap();
    wasOpen.current = open;
    setIsOpen(open);
  }, []);
  const open = useCallback(() => {
    dismissKeyboard();
    progress.set(withSpring(1, SPRING));
    rest(true);
  }, [progress, rest]);
  const close = useCallback(() => {
    progress.set(withSpring(0, SPRING));
    rest(false);
  }, [progress, rest]);

  const drag = usePanGesture({
    enabled: isOpen || swipeOpens,
    // Closed, only a drag to the right is the menu's, so one to the left still turns the page. Open,
    // any sideways drag is: one that cannot move it must not land as a press on what lies beneath.
    activeOffsetX: isOpen ? [-DRAG_START, DRAG_START] : DRAG_START,
    failOffsetY: [-DRAG_STRAY, DRAG_STRAY],
    onActivate: () => {
      "worklet";
      dragStart.set(progress.get());
      scheduleOnRN(dismissKeyboard);
    },
    onUpdate: (event) => {
      "worklet";
      progress.set(draggedProgress(dragStart.get(), event.translationX, menuWidth));
    },
    onDeactivate: (event) => {
      "worklet";
      const opens = restsOpen(progress.get(), event.velocityX);
      progress.set(withSpring(opens ? 1 : 0, { ...SPRING, velocity: event.velocityX / menuWidth }));
      scheduleOnRN(rest, opens);
    },
  });

  useEffect(() => {
    if (!isOpen) return;
    const back = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => back.remove();
  }, [close, isOpen]);

  const menuStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (progress.get() - 1) * menuWidth * 0.25 }],
  }));
  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: progress.get() * menuWidth }],
  }));
  const cornerStyle = useAnimatedStyle(() => ({
    borderRadius: interpolate(progress.get(), [0, 0.2], [0, CARD_RADIUS], Extrapolation.CLAMP),
  }));
  const veilStyle = useAnimatedStyle(() => ({ opacity: progress.get() * 0.5 }));
  const edgeStyle = useAnimatedStyle(() => ({ opacity: progress.get() }));

  const control = useMemo(
    () => ({ isOpen, open, close, drag, setSwipeOpens }),
    [close, drag, isOpen, open],
  );

  return (
    <SideMenuContext value={control}>
      <GestureDetector gesture={drag}>
        <View className="flex-1 bg-surface">
          <Animated.View
            accessibilityElementsHidden={!isOpen}
            importantForAccessibility={isOpen ? "auto" : "no-hide-descendants"}
            pointerEvents={isOpen ? "auto" : "none"}
            style={[styles.menu, { width: menuWidth }, menuStyle]}
          >
            {menu}
          </Animated.View>
          <Animated.View style={[styles.card, cardStyle]}>
            <Animated.View
              accessibilityElementsHidden={isOpen}
              importantForAccessibility={isOpen ? "no-hide-descendants" : "auto"}
              style={[styles.app, cornerStyle]}
            >
              {children}
            </Animated.View>
            <Animated.View
              pointerEvents={isOpen ? "auto" : "none"}
              style={[StyleSheet.absoluteFill, { backgroundColor: veil }, cornerStyle, veilStyle]}
            >
              <Pressable
                accessibilityLabel="Close menu"
                accessibilityRole="button"
                style={StyleSheet.absoluteFill}
                onPress={close}
              />
            </Animated.View>
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.edge,
                { borderColor: edge },
                cornerStyle,
                edgeStyle,
              ]}
            />
          </Animated.View>
        </View>
      </GestureDetector>
    </SideMenuContext>
  );
};

const styles = StyleSheet.create({
  menu: { position: "absolute", top: 0, bottom: 0, left: 0 },
  card: { flex: 1, boxShadow: "-12px 0 40px rgba(0, 0, 0, 0.12)" },
  // One radius for every corner keeps this a plain rounded clip, which glass inside still draws in.
  app: { flex: 1, overflow: "hidden", borderCurve: "continuous" },
  edge: { borderWidth: StyleSheet.hairlineWidth, borderCurve: "continuous" },
});
