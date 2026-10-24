import type { ComponentPropsWithoutRef } from "react";
import avatar0Dark from "@/assets/subagent-avatars/00-honeycomb-dark.svg";
import avatar0Light from "@/assets/subagent-avatars/00-honeycomb-light.svg";
import avatar1Dark from "@/assets/subagent-avatars/01-twin-dark.svg";
import avatar1Light from "@/assets/subagent-avatars/01-twin-light.svg";
import avatar2Dark from "@/assets/subagent-avatars/02-swirl-dark.svg";
import avatar2Light from "@/assets/subagent-avatars/02-swirl-light.svg";
import avatar3Dark from "@/assets/subagent-avatars/03-lotus-dark.svg";
import avatar3Light from "@/assets/subagent-avatars/03-lotus-light.svg";
import avatar4Dark from "@/assets/subagent-avatars/04-clover-dark.svg";
import avatar4Light from "@/assets/subagent-avatars/04-clover-light.svg";
import avatar5Dark from "@/assets/subagent-avatars/05-arch-dark.svg";
import avatar5Light from "@/assets/subagent-avatars/05-arch-light.svg";
import avatar6Dark from "@/assets/subagent-avatars/06-halo-dark.svg";
import avatar6Light from "@/assets/subagent-avatars/06-halo-light.svg";
import avatar7Dark from "@/assets/subagent-avatars/07-triad-dark.svg";
import avatar7Light from "@/assets/subagent-avatars/07-triad-light.svg";
import avatar8Dark from "@/assets/subagent-avatars/08-whirl-dark.svg";
import avatar8Light from "@/assets/subagent-avatars/08-whirl-light.svg";
import avatar9Dark from "@/assets/subagent-avatars/09-flame-dark.svg";
import avatar9Light from "@/assets/subagent-avatars/09-flame-light.svg";
import avatar10Dark from "@/assets/subagent-avatars/10-scallop-dark.svg";
import avatar10Light from "@/assets/subagent-avatars/10-scallop-light.svg";
import avatar11Dark from "@/assets/subagent-avatars/11-moth-dark.svg";
import avatar11Light from "@/assets/subagent-avatars/11-moth-light.svg";
import avatar12Dark from "@/assets/subagent-avatars/12-spark-dark.svg";
import avatar12Light from "@/assets/subagent-avatars/12-spark-light.svg";
import avatar13Dark from "@/assets/subagent-avatars/13-octagram-dark.svg";
import avatar13Light from "@/assets/subagent-avatars/13-octagram-light.svg";
import avatar14Dark from "@/assets/subagent-avatars/14-hexa-dark.svg";
import avatar14Light from "@/assets/subagent-avatars/14-hexa-light.svg";
import avatar15Dark from "@/assets/subagent-avatars/15-drop-dark.svg";
import avatar15Light from "@/assets/subagent-avatars/15-drop-light.svg";
import avatar16Dark from "@/assets/subagent-avatars/16-sprout-dark.svg";
import avatar16Light from "@/assets/subagent-avatars/16-sprout-light.svg";
import avatar17Dark from "@/assets/subagent-avatars/17-trillium-dark.svg";
import avatar17Light from "@/assets/subagent-avatars/17-trillium-light.svg";
import avatar18Dark from "@/assets/subagent-avatars/18-quincunx-dark.svg";
import avatar18Light from "@/assets/subagent-avatars/18-quincunx-light.svg";
import avatar19Dark from "@/assets/subagent-avatars/19-atom-dark.svg";
import avatar19Light from "@/assets/subagent-avatars/19-atom-light.svg";
import avatar20Dark from "@/assets/subagent-avatars/20-gem-dark.svg";
import avatar20Light from "@/assets/subagent-avatars/20-gem-light.svg";
import avatar21Dark from "@/assets/subagent-avatars/21-saturn-dark.svg";
import avatar21Light from "@/assets/subagent-avatars/21-saturn-light.svg";
import avatar22Dark from "@/assets/subagent-avatars/22-compass-dark.svg";
import avatar22Light from "@/assets/subagent-avatars/22-compass-light.svg";
import avatar23Dark from "@/assets/subagent-avatars/23-succulent-dark.svg";
import avatar23Light from "@/assets/subagent-avatars/23-succulent-light.svg";
import avatar24Dark from "@/assets/subagent-avatars/24-sun-dark.svg";
import avatar24Light from "@/assets/subagent-avatars/24-sun-light.svg";
import avatar25Dark from "@/assets/subagent-avatars/25-ammonite-dark.svg";
import avatar25Light from "@/assets/subagent-avatars/25-ammonite-light.svg";
import avatar26Dark from "@/assets/subagent-avatars/26-seal-dark.svg";
import avatar26Light from "@/assets/subagent-avatars/26-seal-light.svg";
import avatar27Dark from "@/assets/subagent-avatars/27-blossom-dark.svg";
import avatar27Light from "@/assets/subagent-avatars/27-blossom-light.svg";
import avatar28Dark from "@/assets/subagent-avatars/28-cradle-dark.svg";
import avatar28Light from "@/assets/subagent-avatars/28-cradle-light.svg";
import avatar29Dark from "@/assets/subagent-avatars/29-trinity-dark.svg";
import avatar29Light from "@/assets/subagent-avatars/29-trinity-light.svg";
import avatar30Dark from "@/assets/subagent-avatars/30-rosette-dark.svg";
import avatar30Light from "@/assets/subagent-avatars/30-rosette-light.svg";
import avatar31Dark from "@/assets/subagent-avatars/31-duo-dark.svg";
import avatar31Light from "@/assets/subagent-avatars/31-duo-light.svg";
import { useDocumentTheme } from "@/lib/use-document-theme";
import { cn } from "@/lib/utils";

const SUBAGENT_AVATAR_HASH_MODULUS = 2_147_483_647;

/** Bank order and capacity are part of the identity contract; do not sort or shuffle. */
export const SUBAGENT_AVATAR_ASSETS = [
  { dark: avatar0Dark, light: avatar0Light },
  { dark: avatar1Dark, light: avatar1Light },
  { dark: avatar2Dark, light: avatar2Light },
  { dark: avatar3Dark, light: avatar3Light },
  { dark: avatar4Dark, light: avatar4Light },
  { dark: avatar5Dark, light: avatar5Light },
  { dark: avatar6Dark, light: avatar6Light },
  { dark: avatar7Dark, light: avatar7Light },
  { dark: avatar8Dark, light: avatar8Light },
  { dark: avatar9Dark, light: avatar9Light },
  { dark: avatar10Dark, light: avatar10Light },
  { dark: avatar11Dark, light: avatar11Light },
  { dark: avatar12Dark, light: avatar12Light },
  { dark: avatar13Dark, light: avatar13Light },
  { dark: avatar14Dark, light: avatar14Light },
  { dark: avatar15Dark, light: avatar15Light },
  { dark: avatar16Dark, light: avatar16Light },
  { dark: avatar17Dark, light: avatar17Light },
  { dark: avatar18Dark, light: avatar18Light },
  { dark: avatar19Dark, light: avatar19Light },
  { dark: avatar20Dark, light: avatar20Light },
  { dark: avatar21Dark, light: avatar21Light },
  { dark: avatar22Dark, light: avatar22Light },
  { dark: avatar23Dark, light: avatar23Light },
  { dark: avatar24Dark, light: avatar24Light },
  { dark: avatar25Dark, light: avatar25Light },
  { dark: avatar26Dark, light: avatar26Light },
  { dark: avatar27Dark, light: avatar27Light },
  { dark: avatar28Dark, light: avatar28Light },
  { dark: avatar29Dark, light: avatar29Light },
  { dark: avatar30Dark, light: avatar30Light },
  { dark: avatar31Dark, light: avatar31Light },
] as const;

/** Derives a slot from the persisted thread ID, without assignment state or collision avoidance. */
export function resolveSubagentAvatarIndex(seed: string): number {
  let hash = 0;
  // Deliberately hash UTF-16 code units, including both halves of surrogate pairs.
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % SUBAGENT_AVATAR_HASH_MODULUS;
  }
  return hash % SUBAGENT_AVATAR_ASSETS.length;
}

export function resolveSubagentAvatarAsset(seed: string): {
  readonly dark: string;
  readonly light: string;
} {
  return SUBAGENT_AVATAR_ASSETS[resolveSubagentAvatarIndex(seed)] ?? SUBAGENT_AVATAR_ASSETS[0];
}

export function SubagentGlyphIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      data-subagent-glyph-icon="true"
      fill="none"
      height="21"
      viewBox="0 0 20 21"
      width="20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M10 13.2135C11.7333 13.2136 13.331 13.7149 14.5117 14.5582C15.691 15.4006 16.4989 16.6247 16.499 18.0455C16.4988 18.4125 16.2009 18.7103 15.834 18.7106C15.4668 18.7106 15.1691 18.4127 15.1689 18.0455C15.1688 17.1656 14.6699 16.3057 13.7383 15.6403C12.8078 14.9757 11.488 14.5436 10 14.5436C8.51211 14.5436 7.19214 14.9758 6.26172 15.6403C5.33026 16.3057 4.83215 17.1657 4.83203 18.0455C4.83186 18.4126 4.53404 18.7104 4.16699 18.7106C3.79983 18.7106 3.50213 18.4127 3.50195 18.0455C3.50207 16.6246 4.3099 15.4006 5.48926 14.5582C6.66991 13.715 8.26685 13.2136 10 13.2135Z"
        fill="currentColor"
      />
      <path
        d="M7.91699 5.54553C8.60724 5.54566 9.16699 6.10526 9.16699 6.79553C9.16699 7.48581 8.60724 8.0454 7.91699 8.04553C7.22664 8.04553 6.66699 7.48589 6.66699 6.79553C6.66699 6.10518 7.22664 5.54553 7.91699 5.54553Z"
        fill="currentColor"
      />
      <path
        d="M12.083 5.54553C12.7734 5.54553 13.333 6.10518 13.333 6.79553C13.333 7.48589 12.7734 8.04553 12.083 8.04553C11.3928 8.0454 10.833 7.48581 10.833 6.79553C10.833 6.10526 11.3928 5.54566 12.083 5.54553Z"
        fill="currentColor"
      />
      <path
        clipRule="evenodd"
        d="M10 1.54749C10.3673 1.54749 10.665 1.84526 10.665 2.21252V2.79749H13.1113C13.554 2.79749 13.9248 2.7969 14.2275 2.82092C14.5377 2.84557 14.8331 2.89914 15.1143 3.03772C15.5745 3.26474 15.9478 3.63796 16.1748 4.09827C16.3133 4.37938 16.367 4.67495 16.3916 4.98499C16.4156 5.28762 16.415 5.65872 16.415 6.1012C16.415 6.99761 16.4157 7.70971 16.3701 8.28284C16.324 8.86308 16.2274 9.35876 16.0029 9.81409C15.6137 10.6032 14.9746 11.2422 14.1855 11.6315C13.73 11.8561 13.2339 11.9525 12.6533 11.9987C12.0802 12.0442 11.369 12.0446 10.4727 12.0446H9.52734C8.631 12.0446 7.91978 12.0442 7.34668 11.9987C6.76612 11.9525 6.26997 11.8561 5.81445 11.6315C5.02538 11.2422 4.38629 10.6032 3.99707 9.81409C3.77258 9.35876 3.67603 8.86308 3.62988 8.28284C3.58434 7.70971 3.58496 6.99761 3.58496 6.1012C3.58496 5.65872 3.5844 5.28762 3.6084 4.98499C3.63303 4.67495 3.6867 4.37938 3.8252 4.09827C4.05219 3.63796 4.42545 3.26474 4.88574 3.03772C5.16693 2.89914 5.46234 2.84557 5.77246 2.82092C6.07515 2.7969 6.44604 2.79749 6.88867 2.79749H9.33496V2.21252C9.33496 1.84526 9.63273 1.54749 10 1.54749ZM6.88867 4.12756C6.42452 4.12756 6.11484 4.12819 5.87695 4.14709C5.64679 4.16542 5.54082 4.19795 5.47363 4.23108C5.27602 4.3286 5.11605 4.48852 5.01855 4.68616C4.98547 4.75336 4.95287 4.85959 4.93457 5.08948C4.91569 5.32732 4.91504 5.63725 4.91504 6.1012C4.91504 7.01891 4.91567 7.66913 4.95605 8.17737C4.99587 8.67788 5.07138 8.98479 5.19043 9.2262C5.45025 9.75279 5.87667 10.1794 6.40332 10.4391C6.64477 10.5581 6.9515 10.6337 7.45215 10.6735C7.96034 10.7138 8.60976 10.7145 9.52734 10.7145H10.4727C11.3902 10.7145 12.0397 10.7138 12.5479 10.6735C13.0485 10.6337 13.3552 10.5581 13.5967 10.4391C14.1233 10.1794 14.5498 9.75279 14.8096 9.2262C14.9286 8.98479 15.0041 8.67788 15.0439 8.17737C15.0843 7.66913 15.085 7.01891 15.085 6.1012C15.085 5.63725 15.0843 5.32732 15.0654 5.08948C15.0471 4.85959 15.0145 4.75336 14.9814 4.68616C14.884 4.48852 14.724 4.3286 14.5264 4.23108C14.4592 4.19795 14.3532 4.16542 14.123 4.14709C13.8852 4.12819 13.5755 4.12756 13.1113 4.12756H6.88867Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
export interface SubagentAvatarProps extends Omit<
  ComponentPropsWithoutRef<"img">,
  "alt" | "draggable" | "src"
> {
  seed: string;
}

export function SubagentAvatar({ seed, className, ...props }: SubagentAvatarProps) {
  const resolvedTheme = useDocumentTheme();
  const index = resolveSubagentAvatarIndex(seed);
  const asset = resolveSubagentAvatarAsset(seed);

  return (
    <img
      {...props}
      alt=""
      className={cn("size-3.5 shrink-0", className)}
      data-subagent-avatar-index={index}
      data-subagent-avatar-seed={seed}
      draggable={false}
      src={asset[resolvedTheme]}
    />
  );
}
