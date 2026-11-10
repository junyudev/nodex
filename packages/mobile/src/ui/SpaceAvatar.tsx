import { View } from "react-native";

import { NodexMark } from "./icons";
import { Txt } from "./primitives";

// Same initials and hue as the desktop's identity glyphs, so a Space looks alike on both.
const initialsOf = (source: string): string => {
  const words = source.split(/[ ._-]+/u).filter(Boolean);
  const first = Array.from(words[0] ?? "")[0] ?? "";
  const last = words.length > 1 ? (Array.from(words.at(-1) ?? "")[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
};

const hueOf = (seed: string): number => {
  let hue = 0;
  for (const char of seed) hue = (hue * 31 + (char.codePointAt(0) ?? 0)) % 360;
  return hue;
};

const DECORATIVE = {
  accessibilityElementsHidden: true,
  importantForAccessibility: "no-hide-descendants",
} as const;

/**
 * A Space is a rounded square, never a person's round avatar. The personal Space is the person's
 * own Nodex and carries its mark; a team Space carries its initials. It always stands beside the
 * Space's name, so a screen reader hears the name alone.
 */
export const SpaceAvatar = ({
  space,
  size,
}: {
  readonly space: {
    readonly spaceId: string;
    readonly name: string;
    readonly kind: "personal" | "team";
  };
  readonly size: number;
}) => {
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.28) };
  if (space.kind === "personal")
    return (
      <View {...DECORATIVE} style={box} className="items-center justify-center bg-surface-3">
        <NodexMark size={Math.round(size * 0.64)} />
      </View>
    );
  return (
    <View
      {...DECORATIVE}
      style={[box, { backgroundColor: `hsl(${hueOf(space.spaceId)}, 42%, 46%)` }]}
      className="items-center justify-center"
    >
      <Txt style={{ fontSize: Math.round(size * 0.4), color: "#fff" }} className="font-semibold">
        {initialsOf(space.name) || "S"}
      </Txt>
    </View>
  );
};
