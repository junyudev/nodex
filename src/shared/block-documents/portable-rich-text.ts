import type * as Y from "yjs";
import { MAX_PAGE_TITLE_LENGTH } from "../page-limits";
import {
  normalizeDateMention,
  type DateMentionDateFormat,
  type DateMentionTimeFormat,
} from "../rich-text/date-mention";
import { RICH_TEXT_ALL_COLORS, type RichTextColor } from "../rich-text/colors";

export const PORTABLE_RICH_TEXT_VERSION = 1;
export const PORTABLE_RICH_TEXT_ATOM_CHARACTER = "\uFFFC";
export const MAX_PORTABLE_RICH_TEXT_SEGMENTS = 512;
export const MAX_PORTABLE_RICH_TEXT_BYTES = 64 * 1024;

const MAX_LINK_LENGTH = 4_096;
const MAX_INLINE_PROPERTY_LENGTH = 1_024;
const ATOM_ATTRIBUTE = "nodexRichTitleAtom";
const LINK_ATTRIBUTE = "link";
const STYLE_ATTRIBUTES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "textColor",
  "backgroundColor",
] as const;
const ALLOWED_DELTA_ATTRIBUTES = new Set<string>([
  ...STYLE_ATTRIBUTES,
  LINK_ATTRIBUTE,
  ATOM_ATTRIBUTE,
]);

export interface PortableRichTextStyles {
  readonly bold?: true;
  readonly italic?: true;
  readonly underline?: true;
  readonly strikethrough?: true;
  readonly code?: true;
  readonly color?: RichTextColor;
}

export interface PortableRichTextText {
  readonly type: "text";
  readonly text: string;
  readonly styles: PortableRichTextStyles;
}

export interface PortableRichTextLink {
  readonly type: "link";
  readonly text: string;
  readonly href: string;
  readonly styles: PortableRichTextStyles;
}

export interface PortableRichTextLineBreak {
  readonly type: "linebreak";
}

export interface PortableRichTextThreadMention {
  readonly type: "threadMention";
  readonly uuid: string;
}

export interface PortableRichTextPageMention {
  readonly type: "pageMention";
  readonly targetPageId: string;
}

export interface PortableRichTextDateMention {
  readonly type: "dateMention";
  readonly start: string;
  readonly end?: string;
  readonly tz?: string;
  readonly format?: DateMentionDateFormat;
  readonly timeFormat?: DateMentionTimeFormat;
  readonly reminder?: string;
}

export type PortableRichTextItem =
  | PortableRichTextText
  | PortableRichTextLink
  | PortableRichTextLineBreak
  | PortableRichTextThreadMention
  | PortableRichTextPageMention
  | PortableRichTextDateMention;

export type PortableRichText = readonly PortableRichTextItem[];

export interface PortableRichTextDeltaOperation {
  readonly insert: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export class PortableRichTextError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortableRichTextError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBoundedString = (
  value: unknown,
  label: string,
  maximumLength = MAX_INLINE_PROPERTY_LENGTH,
): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim()
  ) {
    return value;
  }
  throw new PortableRichTextError(`${label} must be a non-empty bounded string`);
};

const readStyles = (value: unknown, label: string): PortableRichTextStyles => {
  if (!isRecord(value)) {
    throw new PortableRichTextError(`${label} must be an object`);
  }
  const allowed = new Set(["bold", "italic", "underline", "strikethrough", "code", "color"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PortableRichTextError(`${label}.${key} is not supported`);
    }
  }
  const result: {
    bold?: true;
    italic?: true;
    underline?: true;
    strikethrough?: true;
    code?: true;
    color?: RichTextColor;
  } = {};
  for (const key of ["bold", "italic", "underline", "strikethrough", "code"] as const) {
    if (value[key] === undefined || value[key] === false) continue;
    if (value[key] !== true) {
      throw new PortableRichTextError(`${label}.${key} must be true when present`);
    }
    result[key] = true;
  }
  if (value.color !== undefined) {
    if (
      typeof value.color !== "string" ||
      !RICH_TEXT_ALL_COLORS.includes(value.color as RichTextColor)
    ) {
      throw new PortableRichTextError(`${label}.color is not supported`);
    }
    result.color = value.color as RichTextColor;
  }
  return result;
};

const stylesKey = (styles: PortableRichTextStyles): string => JSON.stringify(styles);

const appendText = (
  result: PortableRichTextItem[],
  item: PortableRichTextText | PortableRichTextLink,
): void => {
  const pieces = item.text.split("\n");
  pieces.forEach((piece, index) => {
    if (piece.length > 0) {
      const previous = result.at(-1);
      if (
        previous?.type === item.type &&
        stylesKey(previous.styles) === stylesKey(item.styles) &&
        (item.type !== "link" || (previous.type === "link" && previous.href === item.href))
      ) {
        result[result.length - 1] = { ...previous, text: previous.text + piece };
      } else {
        result.push({ ...item, text: piece });
      }
    }
    if (index < pieces.length - 1) result.push({ type: "linebreak" });
  });
};

const assertExactKeys = (
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(record)) {
    if (allowedSet.has(key)) continue;
    throw new PortableRichTextError(`${label}.${key} is not supported`);
  }
};

const readItem = (value: unknown, index: number): PortableRichTextItem => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new PortableRichTextError(`richTitle[${index}] must be a typed object`);
  }
  const label = `richTitle[${index}]`;
  if (value.type === "text") {
    assertExactKeys(value, ["type", "text", "styles"], label);
    if (typeof value.text !== "string") {
      throw new PortableRichTextError(`${label}.text must be a string`);
    }
    return { type: "text", text: value.text, styles: readStyles(value.styles, `${label}.styles`) };
  }
  if (value.type === "link") {
    assertExactKeys(value, ["type", "text", "href", "styles"], label);
    if (typeof value.text !== "string") {
      throw new PortableRichTextError(`${label}.text must be a string`);
    }
    const href = readBoundedString(value.href, `${label}.href`, MAX_LINK_LENGTH);
    if (/\p{Cc}/u.test(href)) {
      throw new PortableRichTextError(`${label}.href contains control characters`);
    }
    return {
      type: "link",
      text: value.text,
      href,
      styles: readStyles(value.styles, `${label}.styles`),
    };
  }
  if (value.type === "linebreak") {
    assertExactKeys(value, ["type"], label);
    return { type: "linebreak" };
  }
  if (value.type === "threadMention") {
    assertExactKeys(value, ["type", "uuid"], label);
    return {
      type: "threadMention",
      uuid: readBoundedString(value.uuid, `${label}.uuid`),
    };
  }
  if (value.type === "pageMention") {
    assertExactKeys(value, ["type", "targetPageId"], label);
    return {
      type: "pageMention",
      targetPageId: readBoundedString(value.targetPageId, `${label}.targetPageId`),
    };
  }
  if (value.type === "dateMention") {
    assertExactKeys(
      value,
      ["type", "start", "end", "tz", "format", "timeFormat", "reminder"],
      label,
    );
    const normalized = normalizeDateMention({
      type: "dateMention",
      start: typeof value.start === "string" ? value.start : "",
      end: typeof value.end === "string" ? value.end : undefined,
      tz: typeof value.tz === "string" ? value.tz : undefined,
      format:
        typeof value.format === "string" ? (value.format as DateMentionDateFormat) : undefined,
      timeFormat:
        typeof value.timeFormat === "string"
          ? (value.timeFormat as DateMentionTimeFormat)
          : undefined,
      reminder: typeof value.reminder === "string" ? value.reminder : undefined,
    });
    if (!normalized) {
      throw new PortableRichTextError(`${label} is not a valid date mention`);
    }
    return normalized;
  }
  throw new PortableRichTextError(`${label}.type is not title-safe`);
};

export const portableRichTextPlainText = (value: PortableRichText): string =>
  value
    .map((item) => {
      if (item.type === "text" || item.type === "link") return item.text;
      if (item.type === "linebreak") return "\n";
      if (item.type === "threadMention") return `@thread:${item.uuid}`;
      if (item.type === "pageMention") return `@page:${item.targetPageId}`;
      const end = item.end ? `..${item.end}` : "";
      return `@date:${item.start}${end}`;
    })
    .join("");

export const portableRichTextSemanticSource = (value: PortableRichText): string =>
  JSON.stringify(value);

export const canonicalizePortableRichText = (value: unknown): PortableRichText => {
  if (!Array.isArray(value)) {
    throw new PortableRichTextError("richTitle must be an array");
  }
  if (value.length > MAX_PORTABLE_RICH_TEXT_SEGMENTS) {
    throw new PortableRichTextError("richTitle has too many segments");
  }
  const result: PortableRichTextItem[] = [];
  value.forEach((candidate, index) => {
    const item = readItem(candidate, index);
    if ((item.type === "text" || item.type === "link") && item.text.length === 0) {
      return;
    }
    if (item.type === "text" || item.type === "link") {
      appendText(result, item);
      return;
    }
    result.push(item);
  });
  if (result.length > MAX_PORTABLE_RICH_TEXT_SEGMENTS) {
    throw new PortableRichTextError("canonical richTitle has too many segments");
  }
  const plainText = portableRichTextPlainText(result);
  if (plainText.length > MAX_PAGE_TITLE_LENGTH) {
    throw new PortableRichTextError(
      `richTitle plain text exceeds ${MAX_PAGE_TITLE_LENGTH} characters`,
    );
  }
  if (
    new TextEncoder().encode(portableRichTextSemanticSource(result)).byteLength >
    MAX_PORTABLE_RICH_TEXT_BYTES
  ) {
    throw new PortableRichTextError("richTitle exceeds the portable byte limit");
  }
  return result;
};

export const plainTextToPortableRichText = (value: string): PortableRichText =>
  canonicalizePortableRichText(
    value.length === 0 ? [] : [{ type: "text", text: value, styles: {} }],
  );

const stylesToAttributes = (styles: PortableRichTextStyles): Record<string, unknown> => ({
  ...(styles.bold ? { bold: true } : {}),
  ...(styles.italic ? { italic: true } : {}),
  ...(styles.underline ? { underline: true } : {}),
  ...(styles.strikethrough ? { strike: true } : {}),
  ...(styles.code ? { code: true } : {}),
  ...(styles.color?.endsWith("_bg")
    ? { backgroundColor: styles.color }
    : styles.color
      ? { textColor: styles.color }
      : {}),
});

const attributesToStyles = (
  attributes: Readonly<Record<string, unknown>>,
): PortableRichTextStyles => {
  const styles: {
    bold?: true;
    italic?: true;
    underline?: true;
    strikethrough?: true;
    code?: true;
    color?: RichTextColor;
  } = {};
  for (const [attribute, key] of [
    ["bold", "bold"],
    ["italic", "italic"],
    ["underline", "underline"],
    ["strike", "strikethrough"],
    ["code", "code"],
  ] as const) {
    if (attributes[attribute] === undefined || attributes[attribute] === false) continue;
    if (attributes[attribute] !== true) {
      throw new PortableRichTextError(`title Delta ${attribute} must be true`);
    }
    styles[key] = true;
  }
  const color = attributes.backgroundColor ?? attributes.textColor;
  if (color !== undefined) {
    if (attributes.backgroundColor !== undefined && attributes.textColor !== undefined) {
      throw new PortableRichTextError("title Delta cannot contain two color attributes");
    }
    if (typeof color !== "string" || !RICH_TEXT_ALL_COLORS.includes(color as RichTextColor)) {
      throw new PortableRichTextError("title Delta color is not supported");
    }
    const usesBackgroundAttribute = attributes.backgroundColor !== undefined;
    if (usesBackgroundAttribute !== color.endsWith("_bg")) {
      throw new PortableRichTextError("title Delta color uses the wrong attribute");
    }
    styles.color = color as RichTextColor;
  }
  return styles;
};

const atomAttribute = (
  item: PortableRichTextThreadMention | PortableRichTextPageMention | PortableRichTextDateMention,
) => ({
  [ATOM_ATTRIBUTE]: JSON.stringify(item),
});

export const portableRichTextToYTextDelta = (
  value: unknown,
): readonly PortableRichTextDeltaOperation[] =>
  canonicalizePortableRichText(value).map((item) => {
    if (item.type === "linebreak") return { insert: "\n" };
    if (
      item.type === "threadMention" ||
      item.type === "pageMention" ||
      item.type === "dateMention"
    ) {
      return { insert: PORTABLE_RICH_TEXT_ATOM_CHARACTER, attributes: atomAttribute(item) };
    }
    const attributes = {
      ...stylesToAttributes(item.styles),
      ...(item.type === "link" ? { [LINK_ATTRIBUTE]: item.href } : {}),
    };
    return {
      insert: item.text,
      ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    };
  });

export const portableRichTextFromYTextDelta = (value: unknown): PortableRichText => {
  if (!Array.isArray(value)) {
    throw new PortableRichTextError("title Delta must be an array");
  }
  const result: PortableRichTextItem[] = [];
  value.forEach((candidate, index) => {
    if (!isRecord(candidate) || typeof candidate.insert !== "string") {
      throw new PortableRichTextError(`title Delta operation ${index} must insert text`);
    }
    assertExactKeys(candidate, ["insert", "attributes"], `title Delta operation ${index}`);
    const attributes = candidate.attributes === undefined ? {} : candidate.attributes;
    if (!isRecord(attributes)) {
      throw new PortableRichTextError(
        `title Delta operation ${index} attributes must be an object`,
      );
    }
    for (const key of Object.keys(attributes)) {
      if (ALLOWED_DELTA_ATTRIBUTES.has(key)) continue;
      throw new PortableRichTextError(`title Delta attribute ${key} is not supported`);
    }
    if (attributes[ATOM_ATTRIBUTE] !== undefined) {
      if (
        candidate.insert !== PORTABLE_RICH_TEXT_ATOM_CHARACTER ||
        Object.keys(attributes).length !== 1 ||
        typeof attributes[ATOM_ATTRIBUTE] !== "string"
      ) {
        throw new PortableRichTextError(`title Delta atom ${index} is not canonical`);
      }
      let atom: unknown;
      try {
        atom = JSON.parse(attributes[ATOM_ATTRIBUTE]);
      } catch (error) {
        throw new PortableRichTextError(`title Delta atom ${index} is invalid JSON`, {
          cause: error,
        });
      }
      const canonical = canonicalizePortableRichText([atom]);
      const parsed = canonical[0];
      if (
        !parsed ||
        (parsed.type !== "threadMention" &&
          parsed.type !== "pageMention" &&
          parsed.type !== "dateMention")
      ) {
        throw new PortableRichTextError(`title Delta atom ${index} is not title-safe`);
      }
      result.push(parsed);
      return;
    }
    if (candidate.insert.includes(PORTABLE_RICH_TEXT_ATOM_CHARACTER)) {
      throw new PortableRichTextError(`title Delta operation ${index} contains an untyped atom`);
    }
    const styles = attributesToStyles(attributes);
    const link = attributes[LINK_ATTRIBUTE];
    if (link !== undefined && typeof link !== "string") {
      throw new PortableRichTextError(`title Delta link ${index} must be a string`);
    }
    appendText(
      result,
      link === undefined
        ? { type: "text", text: candidate.insert, styles }
        : { type: "link", text: candidate.insert, href: link, styles },
    );
  });
  return canonicalizePortableRichText(result);
};

export const readPortableRichTextFromYText = (title: Y.Text): PortableRichText =>
  portableRichTextFromYTextDelta(title.toDelta());

export const replaceYTextWithPortableRichText = (
  title: Y.Text,
  value: unknown,
  origin?: unknown,
): PortableRichText => {
  const canonical = canonicalizePortableRichText(value);
  const apply = (): void => {
    if (title.length > 0) title.delete(0, title.length);
    const delta = portableRichTextToYTextDelta(canonical);
    if (delta.length > 0) {
      title.applyDelta(delta as Parameters<Y.Text["applyDelta"]>[0]);
    }
  };
  if (!title.doc) {
    throw new PortableRichTextError("title Y.Text must belong to a Y.Doc");
  }
  title.doc.transact(apply, origin);
  return canonical;
};
