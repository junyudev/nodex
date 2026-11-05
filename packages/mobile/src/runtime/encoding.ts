const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(bytes: Uint8Array): string {
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    encoded += digits.charAt(a >> 2) + digits.charAt(((a & 3) << 4) | (b >> 4));
    encoded += i + 1 < bytes.length ? digits.charAt(((b & 15) << 2) | (c >> 6)) : "=";
    encoded += i + 2 < bytes.length ? digits.charAt(c & 63) : "=";
  }
  return encoded;
}

export function fromBase64(value: string): Uint8Array {
  const input = value.replace(/={1,2}$/u, "");
  if (input.length % 4 === 1 || (input !== value && value.length % 4 !== 0)) {
    throw new Error("Invalid base64");
  }
  const bytes = new Uint8Array(Math.floor((input.length * 6) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of input) {
    const digit = digits.indexOf(char);
    if (digit < 0) throw new Error("Invalid base64");
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    bytes[index++] = buffer >>> bits;
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new Error("Invalid base64");
  return bytes;
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid base64url");
  return fromBase64(value.replace(/-/gu, "+").replace(/_/gu, "/"));
}

export function encodeUtf8(value: string): Uint8Array {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(value);
  const escaped = encodeURIComponent(value);
  const bytes = new Uint8Array(escaped.length);
  let length = 0;
  for (let index = 0; index < escaped.length; index++) {
    if (escaped[index] === "%") {
      bytes[length++] = Number.parseInt(escaped.slice(index + 1, index + 3), 16);
      index += 2;
    } else bytes[length++] = escaped.charCodeAt(index);
  }
  return bytes.subarray(0, length);
}

export function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function")
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let escaped = "";
  for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, "0")}`;
  return decodeURIComponent(escaped);
}
