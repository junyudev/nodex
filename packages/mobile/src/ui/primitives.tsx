import * as Haptics from "expo-haptics";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type PressableProps,
  type TextInputProps,
  type TextProps,
  type ViewProps,
} from "react-native";

import { cn } from "./cn";
import { Icon, type IconName } from "./icons";
import { useColor, type ColorToken } from "./tokens";

export const Txt = ({ className, ...props }: TextProps) => (
  <Text className={cn("text-base text-ink", className)} {...props} />
);

/**
 * A press target whose feedback is immediate; no fade. `pressedClassName` holds literal `active:`
 * classes, since the stylesheet only contains classes it can read in the source.
 */
export const Tap = ({
  className,
  pressedClassName = "active:opacity-50",
  ...props
}: Omit<PressableProps, "className"> & {
  readonly className?: string;
  readonly pressedClassName?: string;
}) => (
  <Pressable accessibilityRole="button" {...props} className={cn(className, pressedClassName)} />
);

export const MONOSPACE = Platform.OS === "ios" ? "Menlo" : "monospace";

/** Text whose columns mean something, such as a command or its output. */
export const Mono = ({ style, ...props }: TextProps) => (
  <Txt {...props} style={[{ fontFamily: MONOSPACE }, style]} />
);

export const lightTap = (): void => {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
};

export const IconButton = ({
  name,
  label,
  color = "ink-2",
  size = 20,
  className,
  ...props
}: Omit<PressableProps, "children" | "className"> & {
  readonly name: IconName;
  /** Also its accessible name. */
  readonly label: string;
  readonly color?: ColorToken;
  readonly size?: number;
  readonly className?: string;
}) => (
  <Tap
    accessibilityLabel={label}
    hitSlop={6}
    className={cn("h-9 w-9 items-center justify-center rounded-full", className)}
    pressedClassName="active:bg-fill"
    {...props}
  >
    <Icon name={name} color={color} size={size} />
  </Tap>
);

/** A neutral reference or picker, on a wash so it holds together on glass as well as a surface. */
export const Chip = ({
  icon,
  label,
  trailingChevron,
  className,
  ...props
}: Omit<PressableProps, "children" | "className"> & {
  readonly icon?: IconName;
  readonly label: string;
  readonly trailingChevron?: boolean;
  readonly className?: string;
}) => (
  <Tap
    className={cn("h-8 shrink flex-row items-center gap-1 rounded-full bg-fill px-2.5", className)}
    pressedClassName="active:opacity-50"
    {...props}
  >
    {icon ? <Icon name={icon} size={14} /> : null}
    <Txt className="shrink text-[14px] leading-[18px] text-ink-2" numberOfLines={1}>
      {label}
    </Txt>
    {trailingChevron ? <Icon name="chevronDown" size={10} color="ink-3" /> : null}
  </Tap>
);

export type ButtonTone = "primary" | "default" | "danger";

const BUTTON_TONES: Readonly<Record<ButtonTone, { readonly box: string; readonly text: string }>> =
  {
    primary: { box: "bg-ink", text: "text-surface" },
    default: { box: "bg-fill", text: "text-ink" },
    danger: { box: "bg-danger-soft", text: "text-danger" },
  };

export const Button = ({
  label,
  icon,
  tone = "default",
  compact,
  className,
  disabled,
  ...props
}: Omit<PressableProps, "children" | "className"> & {
  readonly label: string;
  readonly icon?: IconName;
  readonly tone?: ButtonTone;
  readonly compact?: boolean;
  readonly className?: string;
}) => (
  <Tap
    disabled={disabled}
    className={cn(
      "flex-row items-center justify-center gap-1.5 rounded-full",
      compact ? "h-9 px-3.5" : "h-12 px-5",
      BUTTON_TONES[tone].box,
      disabled && "opacity-40",
      className,
    )}
    {...props}
  >
    {icon ? (
      <Icon
        name={icon}
        size={compact ? 15 : 17}
        color={tone === "primary" ? "surface" : tone === "danger" ? "danger" : "ink"}
      />
    ) : null}
    <Txt
      className={cn(compact ? "text-sm" : "text-base", "font-medium", BUTTON_TONES[tone].text)}
      numberOfLines={1}
    >
      {label}
    </Txt>
  </Tap>
);

/** A row in a grouped list or a sheet. */
export const Row = ({
  icon,
  iconColor,
  leading,
  label,
  detail,
  trailing,
  tone,
  className,
  ...props
}: Omit<PressableProps, "children" | "className"> & {
  readonly icon?: IconName;
  /** A richer mark than an icon, such as a Space's avatar. */
  readonly leading?: ReactNode;
  readonly iconColor?: ColorToken;
  readonly label: string;
  readonly detail?: string | null;
  readonly trailing?: ReactNode;
  readonly tone?: "danger";
  readonly className?: string;
}) => (
  <Tap
    className={cn("min-h-12 flex-row items-center gap-3 px-3.5 py-2.5", className)}
    pressedClassName="active:bg-fill"
    {...props}
  >
    {leading ??
      (icon ? (
        <Icon name={icon} color={iconColor ?? (tone === "danger" ? "danger" : "ink-2")} />
      ) : null)}
    <View className="flex-1">
      <Txt className={cn(tone === "danger" && "text-danger")} numberOfLines={1}>
        {label}
      </Txt>
      {detail ? (
        <Txt className="text-sm text-ink-3" numberOfLines={2}>
          {detail}
        </Txt>
      ) : null}
    </View>
    {trailing}
  </Tap>
);

/** One flat grouped surface for rows that belong together. */
export const RowGroup = ({ className, children, ...props }: ViewProps) => (
  <View className={cn("overflow-hidden rounded-[20px] bg-fill", className)} {...props}>
    {children}
  </View>
);

export const SectionLabel = ({ children, className, ...props }: TextProps) => (
  <Txt className={cn("px-1 pb-1.5 text-xs font-medium text-ink-3", className)} {...props}>
    {children}
  </Txt>
);

export const EmptyState = ({
  icon,
  title,
  detail,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly detail?: string;
}) => (
  <View className="flex-1 items-center justify-center gap-2 px-10 py-16">
    <Icon name={icon} size={26} color="ink-3" />
    <Txt className="text-center font-medium">{title}</Txt>
    {detail ? <Txt className="text-center text-sm text-ink-3">{detail}</Txt> : null}
  </View>
);

export const StatusDot = ({
  tone,
}: {
  readonly tone: "accent" | "warning" | "ink-3" | "danger";
}) => (
  <View
    className={cn(
      "h-2 w-2 rounded-full",
      tone === "accent" && "bg-accent",
      tone === "warning" && "bg-warning",
      tone === "danger" && "bg-danger",
      tone === "ink-3" && "bg-ink-3",
    )}
  />
);

/** Waiting, in the app's own ink rather than the platform's accent. */
export const Spinner = ({ size }: { readonly size?: "small" | "large" }) => (
  <ActivityIndicator color={useColor("ink-3")} {...(size ? { size } : {})} />
);

/**
 * A text input in the app's ink and accent, named by what it asks for. It always keeps its font's
 * natural line height: iOS sets an input's text and placeholder low in any taller line, out of line
 * with the controls beside them.
 */
export const Field = ({
  accessibilityLabel,
  placeholder,
  style,
  ...props
}: TextInputProps & { readonly accessibilityLabel: string }) => {
  const accent = useColor("accent");
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      cursorColor={accent}
      placeholder={placeholder ?? accessibilityLabel}
      placeholderTextColor={useColor("ink-3")}
      selectionColor={accent}
      style={[style, { lineHeight: undefined }]}
      {...props}
    />
  );
};
