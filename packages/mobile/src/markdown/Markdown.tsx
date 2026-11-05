import { memo, useMemo } from "react";
import { Linking, Platform, StyleSheet, useColorScheme } from "react-native";
import { EnrichedMarkdownText, type MarkdownStyle } from "react-native-enriched-markdown";

import { resolveFileUri } from "../runtime";
import { MONOSPACE } from "../ui/primitives";
import { useColor } from "../ui/tokens";
import { flattenNodexMarkdown } from "./parse";

export interface MarkdownActions {
  /** A `nodex://sessions/ID` link was tapped. */
  readonly onOpenChat?: (sessionId: string) => void;
}

const NODEX_SESSION_LINK = /^nodex:\/\/sessions\/(.+)$/u;

const openLink = (url: string, actions: MarkdownActions): void => {
  const session = NODEX_SESSION_LINK.exec(url);
  if (session?.[1]) {
    actions.onOpenChat?.(session[1]);
    return;
  }
  if (/^https?:|^mailto:/u.test(url)) void Linking.openURL(url);
};

/** A message's own files arrive through the channel; anything else loads from its URL. */
const resolveImageSource = ({ url }: { readonly url: string }) =>
  url.startsWith("nodex://")
    ? resolveFileUri(url).then(
        (uri) => ({ uri }),
        () => undefined,
      )
    : undefined;

// Android's system font has no semibold through this path, so a heading would read as body text.
const HEADING_WEIGHT = Platform.OS === "ios" ? "600" : "bold";
const BODY_SIZE = 16;
const BODY_LINE = 23;
const CODE_SIZE = 13.5;

const SYNTAX = {
  dark: {
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    constant: "#79c0ff",
    comment: "#8b949e",
    function: "#d2a8ff",
    type: "#ffa657",
    property: "#79c0ff",
    tag: "#7ee787",
    attribute: "#79c0ff",
  },
  light: {
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#0550ae",
    constant: "#0550ae",
    comment: "#6e7781",
    function: "#8250df",
    type: "#953800",
    property: "#0550ae",
    tag: "#116329",
    attribute: "#0550ae",
  },
} as const;

const useMarkdownStyle = (): MarkdownStyle => {
  const ink = useColor("ink");
  const ink2 = useColor("ink-2");
  const ink3 = useColor("ink-3");
  const line = useColor("line");
  const accent = useColor("accent");
  const surface2 = useColor("surface-2");
  const surface3 = useColor("surface-3");
  const surface = useColor("surface");
  const dark = useColorScheme() === "dark";
  return useMemo(() => {
    const body = {
      color: ink,
      fontSize: BODY_SIZE,
      lineHeight: BODY_LINE,
      marginTop: 0,
      marginBottom: 10,
    };
    const heading = (fontSize: number) => ({
      ...body,
      fontSize,
      lineHeight: Math.round(fontSize * 1.35),
      fontWeight: HEADING_WEIGHT,
      marginTop: 6,
    });
    const block = {
      marginTop: 2,
      marginBottom: 12,
      borderRadius: 12,
      // A whole device pixel: half a point lands between pixels on a 3x screen and blurs away.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: line,
    };
    return {
      paragraph: body,
      h1: heading(19),
      h2: heading(18),
      h3: heading(17),
      h4: heading(BODY_SIZE),
      h5: heading(BODY_SIZE),
      h6: heading(BODY_SIZE),
      link: { color: accent, underline: false },
      strong: { fontWeight: "bold" },
      strikethrough: { color: ink3 },
      underline: { color: ink },
      spoiler: { color: ink3 },
      inlineMath: { color: ink },
      math: { color: ink, backgroundColor: surface2 },
      taskList: { checkedColor: accent, checkmarkColor: surface, checkedTextColor: ink3 },
      code: {
        fontFamily: MONOSPACE,
        fontSize: CODE_SIZE,
        color: ink,
        backgroundColor: surface3,
        borderColor: "transparent",
      },
      codeBlock: {
        ...block,
        fontFamily: MONOSPACE,
        fontSize: CODE_SIZE,
        lineHeight: 19,
        color: ink,
        backgroundColor: surface2,
        padding: 12,
        syntaxColors: dark ? SYNTAX.dark : SYNTAX.light,
      },
      blockquote: {
        ...body,
        color: ink2,
        backgroundColor: "transparent",
        borderColor: line,
        borderWidth: 2,
        gapWidth: 12,
      },
      list: { ...body, marginBottom: 4, markerColor: ink3, bulletColor: ink3 },
      thematicBreak: { color: line, height: 0.5, marginTop: 6, marginBottom: 12 },
      image: { borderRadius: 12, marginTop: 2, marginBottom: 12 },
      table: {
        ...block,
        borderRadius: 0,
        fontSize: 14,
        lineHeight: 19,
        color: ink,
        cellPaddingHorizontal: 10,
        cellPaddingVertical: 8,
        headerBackgroundColor: surface2,
        headerTextColor: ink,
        borderColor: line,
        rowEvenBackgroundColor: "transparent",
        rowOddBackgroundColor: "transparent",
      },
    } as MarkdownStyle;
  }, [accent, dark, ink, ink2, ink3, line, surface, surface2, surface3]);
};

/**
 * Nodex Markdown, rendered and selected natively so a long reply streams without re-parsing on the
 * JavaScript thread. A single newline is a line break, as it is everywhere a message is shown.
 */
export const Markdown = memo(function Markdown({
  text,
  actions,
  selectable = true,
  streaming = false,
}: {
  readonly text: string;
  readonly actions?: MarkdownActions;
  readonly selectable?: boolean;
  /** The text is still arriving, so a half-written table or code block shows as it grows. */
  readonly streaming?: boolean;
}) {
  const style = useMarkdownStyle();
  const accent = useColor("accent");
  const markdown = useMemo(() => flattenNodexMarkdown(text), [text]);
  return (
    <EnrichedMarkdownText
      allowTrailingMargin={false}
      containerStyle={{ flexShrink: 1, minWidth: 0 }}
      enableCodeBlockWrapToggle
      enableTaskListItemToggle={false}
      flavor="github"
      markdown={markdown}
      markdownStyle={style}
      md4cFlags={{ admonitions: true, hardSoftBreaks: true, latexMath: true }}
      onLinkPress={({ url }) => openLink(url, actions ?? {})}
      resolveImageSource={resolveImageSource}
      selectable={selectable}
      selectionColor={accent}
      selectionHandleColor={accent}
      {...(streaming
        ? {
            streamingConfig: {
              tableMode: "progressive",
              codeBlockMode: "progressive",
              mediaMode: "progressive",
            } as const,
          }
        : {})}
    />
  );
});
