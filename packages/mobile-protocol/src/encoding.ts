const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const encodeBase64Url = (bytes: Uint8Array): string => {
  let encoded = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      encoded += BASE64URL.charAt((buffer >>> bits) & 63);
    }
  }
  if (bits > 0) encoded += BASE64URL.charAt((buffer << (6 - bits)) & 63);
  return encoded;
};

/** Throws on anything but canonical unpadded base64url. */
export const decodeBase64Url = (encoded: string): Uint8Array => {
  if (encoded.length % 4 === 1) throw new Error("Invalid base64url length");
  const bytes = new Uint8Array(Math.floor((encoded.length * 6) / 8));
  let written = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    const digit = BASE64URL.indexOf(char);
    if (digit < 0) throw new Error("Invalid base64url character");
    buffer = ((buffer << 6) | digit) & 0xffff;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    bytes[written++] = (buffer >>> bits) & 255;
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error("Invalid base64url trailing bits");
  return bytes;
};

// URI encoding supplies UTF-8 without relying on browser globals in the mobile runtime.
export const utf8Bytes = (text: string): Uint8Array =>
  Uint8Array.from(
    encodeURIComponent(text).replace(/%([0-9A-F]{2})/gu, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ),
    (char) => char.charCodeAt(0),
  );

export const utf8Text = (bytes: Uint8Array): string =>
  decodeURIComponent(
    Array.from(bytes, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join(""),
  );
