import type { SVGProps } from "react";
import { TERMINAL_ICON_GEOMETRY } from "../../../../shared/icon-geometry";

export type CanonicalIconProps = SVGProps<SVGSVGElement> & {
  /** Convenience alias used by the older app-owned icon wrappers. */
  ariaHidden?: boolean;
};

type IconPath =
  | string
  | {
      readonly clipRule?: "evenodd";
      readonly d: string;
      readonly fill?: string;
      readonly fillRule?: "evenodd";
      readonly opacity?: number | string;
      readonly stroke?: string;
      readonly strokeLinecap?: "butt" | "round" | "square";
      readonly strokeLinejoin?: SVGProps<SVGPathElement>["strokeLinejoin"];
      readonly strokeWidth?: number | string;
      readonly transform?: string;
    };

type CanonicalGlyphProps = CanonicalIconProps & {
  height?: number | string;
  paths: readonly IconPath[];
  viewBox?: string;
  width?: number | string;
};

const DEFAULT_ICON_CLASS = "icon-xs shrink-0";

function CanonicalGlyph({
  paths,
  viewBox = "0 0 20 20",
  width = 20,
  height = 20,
  className,
  ariaHidden,
  "aria-hidden": ariaHiddenAttribute,
  ...svgProps
}: CanonicalGlyphProps) {
  const hasAccessibleName =
    svgProps["aria-label"] !== undefined || svgProps["aria-labelledby"] !== undefined;

  return (
    <svg
      width={width}
      height={height}
      viewBox={viewBox}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...svgProps}
      className={className ?? DEFAULT_ICON_CLASS}
      aria-hidden={ariaHidden ?? ariaHiddenAttribute ?? (hasAccessibleName ? undefined : true)}
    >
      {paths.map((path, index) => {
        if (typeof path === "string") {
          return <path key={`${path}-${index}`} d={path} fill="currentColor" />;
        }

        return (
          <path
            key={`${path.d}-${index}`}
            d={path.d}
            fill={path.fill ?? "currentColor"}
            fillRule={path.fillRule}
            clipRule={path.clipRule}
            opacity={path.opacity}
            stroke={path.stroke}
            strokeWidth={path.strokeWidth}
            strokeLinecap={path.strokeLinecap}
            strokeLinejoin={path.strokeLinejoin}
            transform={path.transform}
          />
        );
      })}
    </svg>
  );
}

const COPY_PATH =
  "M15.1 1.785a3.065 3.065 0 0 1 3.065 3.066v6.033a3.065 3.065 0 0 1-3.064 3.064h-1.103v1.103a3.065 3.065 0 0 1-3.064 3.064H4.9a3.066 3.066 0 0 1-3.065-3.064V9.018A3.066 3.066 0 0 1 4.9 5.952h1.102V4.851a3.066 3.066 0 0 1 3.065-3.066zM4.9 7.282c-.958 0-1.735.777-1.735 1.736v6.033c0 .958.777 1.734 1.735 1.734h6.034c.957 0 1.734-.776 1.734-1.734V9.018c0-.959-.776-1.736-1.734-1.736zm4.167-4.167c-.958 0-1.735.777-1.735 1.736v1.101h3.602a3.065 3.065 0 0 1 3.064 3.066v3.6h1.103c.957 0 1.734-.776 1.734-1.734V4.85c0-.958-.777-1.735-1.734-1.736z";

const MORE_ACTIONS_PATHS = [
  "M15.6981 9.04712C16.5255 9.04712 17.1959 9.71781 17.1961 10.5452C17.1961 11.3727 16.5256 12.0442 15.6981 12.0442C14.8706 12.0442 14.2 11.3727 14.2 10.5452C14.2002 9.71781 14.8707 9.04712 15.6981 9.04712Z",
  "M4.69806 9.04712C5.52546 9.04712 6.19691 9.71781 6.19708 10.5452C6.19708 11.3727 5.52557 12.0442 4.69806 12.0442C3.8707 12.044 3.20001 11.3726 3.20001 10.5452C3.20019 9.71792 3.87081 9.04729 4.69806 9.04712Z",
  "M10.2003 9.04712C11.0276 9.0473 11.6982 9.71792 11.6984 10.5452C11.6984 11.3726 11.0277 12.044 10.2003 12.0442C9.37284 12.0442 8.70132 11.3727 8.70132 10.5452C8.7015 9.71781 9.37295 9.04712 10.2003 9.04712Z",
] as const;

const BACK_PATH =
  "M8.8011 3.611C9.05912 3.44087 9.40989 3.46898 9.63703 3.69596C9.89673 3.95566 9.89673 4.37767 9.63703 4.63737L4.93977 9.33463H16.6663L16.8011 9.34831C17.1038 9.41043 17.3312 9.67859 17.3314 9.99967C17.3314 10.3209 17.1039 10.5888 16.8011 10.651L16.6663 10.6647H4.93879L9.63703 15.363L9.722 15.4674C9.89241 15.7255 9.86413 16.0761 9.63703 16.3034C9.40981 16.5306 9.05921 16.5587 8.8011 16.3883L8.69661 16.3034L2.86262 10.4704C2.60319 10.2108 2.6033 9.78962 2.86262 9.52995L8.69661 3.69596L8.8011 3.611Z";

const OPEN_EXTERNAL_PATH =
  "M11.949 3.47949C12.0997 3.46465 12.2553 3.51279 12.3709 3.62793C12.4863 3.74328 12.5338 3.89898 12.5193 4.0498C12.5206 4.06633 12.5251 4.08275 12.5252 4.09961V10.667C12.525 10.9565 12.2902 11.191 12.0007 11.1914C11.7109 11.1914 11.4755 10.9568 11.4754 10.667V5.2666L4.37184 12.376C4.16684 12.5807 3.83365 12.5808 3.62867 12.376C3.42385 12.1711 3.42396 11.8388 3.62867 11.6338L10.7332 4.52539H5.33375C5.0438 4.52539 4.80836 4.28995 4.80836 4C4.80836 3.71005 5.0438 3.47461 5.33375 3.47461H11.9002C11.9167 3.47462 11.9328 3.47822 11.949 3.47949Z";

const CONVERSATION_PATH =
  "M13.4746 8.00098C13.4746 5.18918 11.0524 2.85938 8 2.85938C4.94756 2.85938 2.52539 5.18918 2.52539 8.00098C2.52548 9.13438 2.98018 9.88391 3.55176 11.0156C3.62017 11.1511 3.63938 11.3067 3.60645 11.4551L3.34277 12.6416L4.62598 12.3096L4.74023 12.29C4.81669 12.2841 4.89333 12.2922 4.9668 12.3125L5.0752 12.3525L5.44238 12.5225C6.29248 12.9002 7.09158 13.1426 8 13.1426C11.0523 13.1426 13.4744 10.8126 13.4746 8.00098ZM14.5254 8.00098C14.5252 11.4483 11.5749 14.1924 8 14.1924C6.78477 14.1924 5.75932 13.8299 4.75488 13.3604L2.9873 13.8193C2.5113 13.9426 2.07317 13.5191 2.17969 13.0391L2.5498 11.3643C2.03641 10.3607 1.4747 9.38268 1.47461 8.00098C1.47461 4.55354 4.42502 1.80859 8 1.80859C11.575 1.80859 14.5254 4.55354 14.5254 8.00098Z";

const DATABASE_LABEL_PATHS = [
  "M12 11.5V13H5.132v-1.5zm1.5-1.5V6a1.5 1.5 0 0 0-1.346-1.492L12 4.5H5.133a.5.5 0 0 0-.303.103l-.08.076-2.382 2.834a.5.5 0 0 0-.11.234l-.008.087v.331a.5.5 0 0 0 .118.321l2.382 2.835a.5.5 0 0 0 .383.179V13l-.22-.012a2 2 0 0 1-1.16-.54l-.15-.16L1.218 9.45a2 2 0 0 1-.46-1.11L.75 8.165v-.331a2 2 0 0 1 .363-1.147l.106-.14 2.383-2.834a2 2 0 0 1 1.312-.701L5.134 3H12a3 3 0 0 1 3 3v4a3 3 0 0 1-3.002 3v-1.5a1.5 1.5 0 0 0 1.494-1.347z",
  "M5.5 8a1 1 0 1 1 2 0 1 1 0 0 1-2 0",
] as const;

const FULL_WIDTH_PATH =
  "M13 3v10M3 3v10M10.5 8H13M6 8l1.5-1.5M6 8l1.5 1.5M10 8l-1.5-1.5M10 8l-1.5 1.5M3 8h2.5";
const FULL_WIDTH_PATHS = [
  {
    d: FULL_WIDTH_PATH,
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: 1.5,
  },
] as const;

const DIRECTIONAL_ARROW_PATH =
  "M9.33467 16.6663V4.93978L4.6374 9.63704L4.1667 9.16634L3.69599 8.69661L9.52998 2.86263L9.63447 2.77767C9.8925 2.60753 10.2433 2.63564 10.4704 2.86263L16.3034 8.69661L16.3884 8.80111C16.5588 9.05922 16.5306 9.40982 16.3034 9.63704C16.0762 9.86414 15.7255 9.89242 15.4675 9.722L15.363 9.63704L10.6647 4.9388V16.6663C10.6647 17.0336 10.367 17.3314 9.99971 17.3314C9.63259 17.3312 9.33467 17.0335 9.33467 16.6663ZM4.6374 9.63704C4.3777 9.89674 3.95569 9.89674 3.69599 9.63704C3.43657 9.37744 3.43668 8.95628 3.69599 8.69661L4.6374 9.63704Z";

const DIRECTIONAL_ARROW_PATHS = [{ d: DIRECTIONAL_ARROW_PATH }] as const;
const DIRECTIONAL_ARROW_DOWN_PATHS = [
  { d: DIRECTIONAL_ARROW_PATH, transform: "rotate(180 10 10)" },
] as const;

const FILTER_PATHS = [
  "M12.5 14.0049C12.8673 14.0049 13.165 14.3027 13.165 14.6699C13.165 15.0372 12.8673 15.335 12.5 15.335H7.5C7.13273 15.335 6.83496 15.0372 6.83496 14.6699C6.83496 14.3027 7.13273 14.0049 7.5 14.0049H12.5Z",
  "M15 9.33496C15.3673 9.33496 15.665 9.63273 15.665 10C15.665 10.3673 15.3673 10.665 15 10.665H5C4.63273 10.665 4.33496 10.3673 4.33496 10C4.33496 9.63273 4.63273 9.33496 5 9.33496H15Z",
  "M17.5 4.66504C17.8673 4.66504 18.165 4.96281 18.165 5.33008C18.165 5.69735 17.8673 5.99512 17.5 5.99512H2.5C2.13273 5.99512 1.83496 5.69735 1.83496 5.33008C1.83496 4.96281 2.13273 4.66504 2.5 4.66504H17.5Z",
] as const;

const LIST_LAYOUT_PATHS = [
  "M3 5h.01",
  "M3 12h.01",
  "M3 19h.01",
  "M8 5h13",
  "M8 12h13",
  "M8 19h13",
].map((d) => ({
  d,
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 2,
}));

const INFO_PATHS = [
  {
    d: "M10 1.75C14.5563 1.75 18.25 5.44365 18.25 10C18.25 14.5563 14.5563 18.25 10 18.25C5.44365 18.25 1.75 14.5563 1.75 10C1.75 5.44365 5.44365 1.75 10 1.75ZM10 3.25C6.27208 3.25 3.25 6.27208 3.25 10C3.25 13.7279 6.27208 16.75 10 16.75C13.7279 16.75 16.75 13.7279 16.75 10C16.75 6.27208 13.7279 3.25 10 3.25Z",
    fillRule: "evenodd",
    clipRule: "evenodd",
  },
  "M9.25 8.25H10.75V14H9.25V8.25ZM10 5.25C10.5523 5.25 11 5.69772 11 6.25C11 6.80228 10.5523 7.25 10 7.25C9.44772 7.25 9 6.80228 9 6.25C9 5.69772 9.44772 5.25 10 5.25Z",
] as const;

const HISTORY_PATH =
  "M10 2.25C14.2802 2.25 17.75 5.71979 17.75 10C17.75 14.2802 14.2802 17.75 10 17.75C6.71706 17.75 3.90026 15.7115 2.736 12.8125H4.374C5.38877 14.8245 7.47908 16.25 10 16.25C13.4518 16.25 16.25 13.4518 16.25 10C16.25 6.54822 13.4518 3.75 10 3.75C7.47287 3.75 5.37809 5.18254 4.36618 7.203H6.25V8.703H2.25V4.703H3.75V6.073C5.15051 3.76289 7.56818 2.25 10 2.25ZM9.25 5.75H10.75V9.688L13.237 12.175L12.175 13.237L9.25 10.312V5.75Z";

const PAGE_HISTORY_PATHS = [
  {
    d: "M8 4v4l3 1.5M14 8a6 6 0 11-12 0 6 6 0 0112 0z",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeWidth: 1.5,
  },
] as const;

const VISIBILITY_PATHS = [
  {
    d: "M10 4C15.4 4 18.5 9.99999 18.5 9.99999C18.5 9.99999 15.4 16 10 16C4.6 16 1.5 9.99999 1.5 9.99999C1.5 9.99999 4.6 4 10 4ZM10 5.5C6.623 5.5 4.257 8.633 3.241 10C4.257 11.367 6.623 14.5 10 14.5C13.377 14.5 15.743 11.367 16.759 10C15.743 8.633 13.377 5.5 10 5.5Z",
    fillRule: "evenodd",
    clipRule: "evenodd",
  },
  "M10 7.25C11.5188 7.25 12.75 8.48122 12.75 10C12.75 11.5188 11.5188 12.75 10 12.75C8.48122 12.75 7.25 11.5188 7.25 10C7.25 8.48122 8.48122 7.25 10 7.25Z",
] as const;

const VISIBILITY_OFF_PATHS = [
  ...VISIBILITY_PATHS,
  {
    d: "M3.03 2.97L17.03 16.97L15.97 18.03L1.97 4.03L3.03 2.97Z",
  },
] as const;

const LOADING_PATHS = [
  {
    d: "M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z",
    opacity: 0.3,
  },
  {
    d: "M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z",
  },
] as const;

const IMAGE_PATHS = [
  "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z",
  "M11 9a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  "m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21",
].map((d) => ({
  d,
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  strokeWidth: 2,
}));

const RETRY_PATH =
  "M16.4183 9.99967C16.4181 6.45518 13.5448 3.58188 10.0003 3.58171C7.96895 3.58171 6.15935 4.52712 4.98273 6.00163H7.50031L7.6341 6.0153C7.93707 6.07735 8.16535 6.34535 8.16535 6.66667C8.16535 6.98799 7.93707 7.25598 7.6341 7.31803L7.50031 7.33171H3.75031C3.73055 7.33171 3.71104 7.32656 3.69172 7.32487C3.68913 7.32464 3.68649 7.32513 3.68391 7.32487C3.64304 7.32082 3.60409 7.31254 3.56574 7.30143C3.56188 7.30031 3.55788 7.2997 3.55402 7.2985C3.51366 7.286 3.47546 7.27023 3.43879 7.25065L3.43586 7.24967C3.43444 7.24891 3.43337 7.24752 3.43195 7.24675C3.35757 7.20587 3.29219 7.15262 3.23859 7.08757C3.23505 7.08329 3.23128 7.07923 3.22785 7.07487C3.20549 7.04631 3.1858 7.01609 3.16828 6.98405C3.16491 6.97791 3.16169 6.97173 3.15852 6.9655C3.14408 6.93698 3.13265 6.90732 3.12238 6.87663C3.11744 6.86205 3.11264 6.84757 3.10871 6.83268C3.10316 6.81117 3.09843 6.78955 3.09504 6.76725C3.09108 6.74233 3.08833 6.71738 3.08723 6.69206C3.08691 6.68361 3.08527 6.67519 3.08527 6.66667V2.91667C3.08527 2.5494 3.38304 2.25163 3.75031 2.25163C4.11743 2.2518 4.41535 2.54951 4.41535 2.91667V4.62956C5.82462 3.16447 7.80565 2.25163 10.0003 2.25163C14.2793 2.2518 17.7482 5.72065 17.7484 9.99967C17.7484 14.2789 14.2794 17.7485 10.0003 17.7487C6.02899 17.7487 2.75629 14.7612 2.305 10.9108L2.96516 10.8337L3.62531 10.7555C3.99895 13.9437 6.7115 16.4186 10.0003 16.4186C13.5449 16.4184 16.4183 13.5443 16.4183 9.99967ZM2.88801 10.1725C3.25252 10.13 3.58237 10.3911 3.62531 10.7555L2.305 10.9108C2.26225 10.546 2.52323 10.2153 2.88801 10.1725Z";

const PLAY_PATH =
  "M6 14.7227V5.27693C6 4.29057 7.08894 3.6928 7.9211 4.22235L15.3428 8.94526C16.1147 9.43645 16.1147 10.5632 15.3428 11.0544L7.92109 15.7773C7.08894 16.3069 6 15.7091 6 14.7227Z";

const PAUSE_PATHS = [
  "M6 4.75C6 4.33579 6.33579 4 6.75 4H8.25C8.66421 4 9 4.33579 9 4.75V15.25C9 15.6642 8.66421 16 8.25 16H6.75C6.33579 16 6 15.6642 6 15.25V4.75Z",
  "M11 4.75C11 4.33579 11.3358 4 11.75 4H13.25C13.6642 4 14 4.33579 14 4.75V15.25C14 15.6642 13.6642 16 13.25 16H11.75C11.3358 16 11 15.6642 11 15.25V4.75Z",
] as const;

export function CopyIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      paths={[{ d: COPY_PATH, fillRule: "evenodd", clipRule: "evenodd" }]}
    />
  );
}

export function MoreActionsIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={21}
      height={21}
      viewBox="0 0 21 21"
      paths={MORE_ACTIONS_PATHS}
    />
  );
}

export function TerminalIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={TERMINAL_ICON_GEOMETRY.paths} />;
}

export function BackIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={[BACK_PATH]} />;
}

export function OpenExternalIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      paths={[OPEN_EXTERNAL_PATH]}
    />
  );
}

export function ConversationIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      paths={[CONVERSATION_PATH]}
    />
  );
}

export function DatabaseLabelIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      paths={DATABASE_LABEL_PATHS}
    />
  );
}

/** Full-width page-stage affordance: two rails with inward-pointing arrows. */
export function FullWidthIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      paths={FULL_WIDTH_PATHS}
    />
  );
}

export function SortAscendingIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={DIRECTIONAL_ARROW_PATHS} />;
}

export function SortDescendingIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={DIRECTIONAL_ARROW_DOWN_PATHS} />;
}

export function MoveUpIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={DIRECTIONAL_ARROW_PATHS} />;
}

export function MoveDownIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={DIRECTIONAL_ARROW_DOWN_PATHS} />;
}

export function FilterIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={FILTER_PATHS} />;
}

export function ListLayoutIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={24}
      height={24}
      viewBox="0 0 24 24"
      paths={LIST_LAYOUT_PATHS}
    />
  );
}

export function InfoIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={INFO_PATHS} />;
}

export function HistoryIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={[HISTORY_PATH]} />;
}

export function PageHistoryIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph
      {...props}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      paths={PAGE_HISTORY_PATHS}
    />
  );
}

/**
 * Static loading identity. Callers own any animation class or transition so
 * the glyph stays usable in reduced-motion and non-animated surfaces.
 */
export function LoadingIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph {...props} width={24} height={24} viewBox="0 0 24 24" paths={LOADING_PATHS} />
  );
}

export function VisibilityIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={VISIBILITY_PATHS} />;
}

export function VisibilityOffIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={VISIBILITY_OFF_PATHS} />;
}

export function ImageIcon(props: CanonicalIconProps) {
  return (
    <CanonicalGlyph {...props} width={24} height={24} viewBox="0 0 24 24" paths={IMAGE_PATHS} />
  );
}

export function RetryIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={[RETRY_PATH]} />;
}

export function ResetIcon(props: CanonicalIconProps) {
  return <RetryIcon {...props} />;
}

export function PlayIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={[PLAY_PATH]} />;
}

export function PauseIcon(props: CanonicalIconProps) {
  return <CanonicalGlyph {...props} paths={PAUSE_PATHS} />;
}
