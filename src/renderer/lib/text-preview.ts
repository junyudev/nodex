import { getIntl } from "@/lib/i18n";
export type TextPreview =
  | {
      readonly kind: "complete";
      readonly text: string;
    }
  | {
      readonly kind: "omitted";
      readonly text: string;
      readonly omittedCharacters: number;
    };

export const INLINE_TEXT_PREVIEW_MAX_CHARS = 32_000;

export function buildTextPreview(value: string, maxChars: number): TextPreview {
  assertValidCharacterLimit(maxChars);
  if (value.length <= maxChars) return { kind: "complete", text: value };

  let marker = buildOmissionMarker(value.length - maxChars);
  let visibleCharacters = Math.max(0, maxChars - marker.length);
  let omittedCharacters = value.length - visibleCharacters;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    marker = buildOmissionMarker(omittedCharacters);
    visibleCharacters = Math.max(0, maxChars - marker.length);
    const nextOmittedCharacters = value.length - visibleCharacters;
    if (nextOmittedCharacters === omittedCharacters) break;
    omittedCharacters = nextOmittedCharacters;
  }

  marker = buildOmissionMarker(omittedCharacters);
  if (marker.length >= maxChars) {
    return {
      kind: "omitted",
      text: marker.slice(0, maxChars),
      omittedCharacters,
    };
  }

  visibleCharacters = maxChars - marker.length;
  const headLength = Math.ceil(visibleCharacters / 2);
  const tailLength = visibleCharacters - headLength;
  return {
    kind: "omitted",
    text: value.slice(0, headLength) + marker + value.slice(value.length - tailLength),
    omittedCharacters: value.length - visibleCharacters,
  };
}

function buildOmissionMarker(omittedCharacters: number): string {
  return getIntl().formatMessage(
    {
      id: "lib.textPreview.omission",
      defaultMessage: "\n… {count, number} characters omitted …\n",
    },
    { count: omittedCharacters },
  );
}

function assertValidCharacterLimit(maxChars: number): void {
  if (Number.isSafeInteger(maxChars) && maxChars >= 0) return;
  throw new RangeError("maxChars must be a non-negative safe integer");
}
