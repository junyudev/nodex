import {
  AspectRatio1120Glyph,
  AspectRatio3420Glyph,
  AspectRatio91620Glyph,
  AspectRatio4320Glyph,
  AspectRatio16920Glyph,
  SquareGrid2x216Glyph,
} from "./outline-glyphs";
import type { JSX } from "react";

type ImageEditorAspectIconProps = JSX.IntrinsicElements["svg"];

export function SquareAspectRatioIcon(props: ImageEditorAspectIconProps) {
  return <AspectRatio1120Glyph {...props} />;
}

export function PortraitAspectRatioIcon(props: ImageEditorAspectIconProps) {
  return <AspectRatio3420Glyph {...props} />;
}

export function StoryAspectRatioIcon(props: ImageEditorAspectIconProps) {
  return <AspectRatio91620Glyph {...props} />;
}

export function LandscapeAspectRatioIcon(props: ImageEditorAspectIconProps) {
  return <AspectRatio4320Glyph {...props} />;
}

export function WidescreenAspectRatioIcon(props: ImageEditorAspectIconProps) {
  return <AspectRatio16920Glyph {...props} />;
}

export function ImageResizeIcon(props: ImageEditorAspectIconProps) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d={
          "M14.667 4.80762C15.6931 4.80779 16.5252 5.63994 16.5254 6.66602V13.333C16.5254 14.3592 15.6932 15.1912 14.667 15.1914H5.33301C4.30683 15.1912 3.47461 14.3592 3.47461 13.333V6.66602C3.47478 5.63994 4.30694 4.80779 5.33301 4.80762H14.667ZM5.33301 5.8584C4.88683 5.85857 4.52557 6.21984 4.52539 6.66602V8.99414C4.76984 8.87578 5.04327 8.80767 5.33301 8.80762H10.667C11.6931 8.80779 12.5252 9.63995 12.5254 10.666V13.333C12.5254 13.6232 12.4566 13.8969 12.3379 14.1416H14.667C15.1133 14.1414 15.4746 13.7793 15.4746 13.333V6.66602C15.4744 6.21984 15.1132 5.85857 14.667 5.8584H5.33301ZM5.33301 9.8584C4.88684 9.85857 4.52557 10.2198 4.52539 10.666V13.333C4.52539 13.7793 4.88673 14.1414 5.33301 14.1416H10.667C11.1133 14.1414 11.4746 13.7793 11.4746 13.333V10.666C11.4744 10.2198 11.1132 9.85857 10.667 9.8584H5.33301Z"
        }
      />
    </svg>
  );
}

export function ImageCanvasViewIcon(props: ImageEditorAspectIconProps) {
  return <SquareGrid2x216Glyph {...props} />;
}

export function ImageFocusedViewIcon(props: ImageEditorAspectIconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <g transform="translate(1.468 2.11)">
        <path
          d={
            "M12 5.757C12 5.188 11.999 4.794 11.974 4.487C11.95 4.186 11.904 4.017 11.84 3.891C11.699 3.614 11.475 3.39 11.198 3.249C11.072 3.185 10.903 3.139 10.602 3.115C10.296 3.09 9.901 3.089 9.332 3.089H3.732C3.163 3.089 2.769 3.09 2.462 3.115C2.161 3.139 1.992 3.185 1.866 3.249C1.589 3.39 1.365 3.614 1.224 3.891C1.16 4.017 1.114 4.186 1.09 4.487C1.065 4.794 1.064 5.188 1.064 5.757V7.757C1.064 8.326 1.065 8.721 1.09 9.027C1.114 9.328 1.16 9.497 1.224 9.623C1.365 9.9 1.589 10.124 1.866 10.265C1.992 10.329 2.161 10.375 2.462 10.399C2.769 10.424 3.163 10.425 3.732 10.425H9.332C9.901 10.425 10.296 10.424 10.602 10.399C10.903 10.375 11.072 10.329 11.198 10.265C11.475 10.124 11.699 9.9 11.84 9.623C11.904 9.497 11.95 9.328 11.974 9.027C11.999 8.721 12 8.326 12 7.757V5.757ZM8.347 0.006L10.538 0.025L10.645 0.037C10.886 0.089 11.067 0.305 11.064 0.563C11.061 0.819 10.877 1.032 10.634 1.079L10.527 1.089L8.342 1.07C6.407 1.058 5.035 1.064 2.538 1.089C2.244 1.092 2.003 0.856 2 0.563C1.997 0.269 2.233 0.028 2.527 0.025C5.029 0 6.407 -0.006 8.347 0.006ZM13.064 7.757C13.064 8.308 13.065 8.754 13.035 9.114C13.005 9.48 12.942 9.805 12.788 10.106C12.546 10.583 12.158 10.971 11.681 11.213C11.38 11.367 11.055 11.43 10.689 11.46C10.329 11.49 9.883 11.489 9.332 11.489H3.732C3.181 11.489 2.735 11.49 2.375 11.46C2.009 11.43 1.684 11.367 1.383 11.213C0.906 10.971 0.519 10.583 0.276 10.106C0.122 9.805 0.059 9.48 0.029 9.114C0 8.754 0 8.308 0 7.757V5.757C0 5.206 0 4.76 0.029 4.4C0.059 4.034 0.122 3.709 0.276 3.408C0.519 2.931 0.906 2.544 1.383 2.301C1.684 2.147 2.009 2.084 2.375 2.054C2.735 2.024 3.181 2.025 3.732 2.025H9.332C9.883 2.025 10.329 2.024 10.689 2.054C11.055 2.084 11.38 2.147 11.681 2.301C12.158 2.544 12.546 2.931 12.788 3.408C12.942 3.709 13.005 4.034 13.035 4.4C13.065 4.76 13.064 5.206 13.064 5.757V7.757Z"
          }
          fill="currentColor"
        />
      </g>
    </svg>
  );
}
