import { useEffect, type CSSProperties } from "react";
import type { Decorator, Preview } from "@storybook/react-vite";
import { AppProviders, initializeRendererDocument } from "../../../src/renderer/app-providers";
import {
  getDevStoryFontSizeCssVariables,
  readDevStoryCodeFontSize,
  readDevStorySansFontSize,
} from "../../../src/renderer/lib/dev-story-font-size";
import { useTheme } from "../../../src/renderer/lib/use-theme";

initializeRendererDocument({ storybook: true });

const DEFAULT_SANS_FONT_SIZE = readDevStorySansFontSize();
const DEFAULT_CODE_FONT_SIZE = readDevStoryCodeFontSize();

function resolveTheme(value: unknown): "light" | "dark" | "system" {
  if (value === "light" || value === "dark" || value === "system") return value;
  return "system";
}

function resolveFontSize(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function ThemeGlobalsSync({ theme }: { theme: unknown }) {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(resolveTheme(theme));
  }, [setTheme, theme]);

  return null;
}

const withNodexFrame: Decorator = (Story, context) => {
  const sansFontSize = resolveFontSize(context.globals.sansFontSize, DEFAULT_SANS_FONT_SIZE);
  const codeFontSize = resolveFontSize(context.globals.codeFontSize, DEFAULT_CODE_FONT_SIZE);
  const fontSizeVariables = getDevStoryFontSizeCssVariables({
    sansFontSize,
    codeFontSize,
  }) as unknown as CSSProperties;

  return (
    <AppProviders>
      <ThemeGlobalsSync theme={context.globals.theme} />
      <div
        className="min-h-screen bg-(--background) px-6 py-6 text-(--foreground)"
        style={fontSizeVariables}
      >
        <Story />
      </div>
    </AppProviders>
  );
};

const preview: Preview = {
  decorators: [withNodexFrame],
  globalTypes: {
    theme: {
      name: "Theme",
      description: "Global color theme",
      defaultValue: "system",
      toolbar: {
        icon: "mirror",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
          { value: "system", title: "System" },
        ],
      },
    },
    sansFontSize: {
      name: "Sans",
      description: "Story sans font size",
      defaultValue: DEFAULT_SANS_FONT_SIZE,
      toolbar: {
        icon: "paragraph",
        items: [12, 13, 14, 15, 16, 18].map((value) => ({
          value,
          title: `${value}px`,
        })),
      },
    },
    codeFontSize: {
      name: "Code",
      description: "Story code font size",
      defaultValue: DEFAULT_CODE_FONT_SIZE,
      toolbar: {
        icon: "markup",
        items: [12, 13, 14, 15, 16, 18].map((value) => ({
          value,
          title: `${value}px`,
        })),
      },
    },
  },
  parameters: {
    layout: "fullscreen",
    actions: {
      argTypesRegex: "^on.*",
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    a11y: {
      test: "todo",
    },
  },
};

export default preview;
