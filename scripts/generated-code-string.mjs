// Keep exported API changes paired with the adjacent .d.mts contract.
const UNSAFE_CODE_LITERAL_CHARACTER = /[<>\u2028\u2029]/gu;

const CODE_LITERAL_ESCAPE = Object.freeze({
  "<": "\\u003c",
  ">": "\\u003e",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
});

/** Serialize a string for interpolation into generated JavaScript or TypeScript source. */
export function serializeGeneratedCodeString(value) {
  if (typeof value !== "string") {
    throw new TypeError("Generated code string values must be strings");
  }
  return JSON.stringify(value).replace(
    UNSAFE_CODE_LITERAL_CHARACTER,
    (character) => CODE_LITERAL_ESCAPE[character],
  );
}
