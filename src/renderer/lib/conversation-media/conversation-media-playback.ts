export const safeDuration = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
export function displayTime(value: number) {
  const seconds = Math.floor(safeDuration(value));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function mediaDataBytes(payload: string, base64: boolean) {
  if (base64 && !payload.includes("%")) return decodeBase64(payload);
  const encoded = new TextEncoder().encode(payload);
  let length = 0;
  for (let index = 0; index < encoded.length; index++) {
    const pair = String.fromCharCode(encoded[index + 1] ?? 0, encoded[index + 2] ?? 0);
    if (encoded[index] === 37 && /^[\da-f]{2}$/iu.test(pair)) {
      encoded[length++] = Number.parseInt(pair, 16);
      index += 2;
      continue;
    }
    encoded[length++] = encoded[index]!;
  }
  const content = encoded.subarray(0, length);
  return base64 ? decodeBase64(new TextDecoder().decode(content)) : content;
}

/** A mounted decoder owns this URL; file bytes and downloads remain with the media resource. */
export function attachMediaDataSource(element: HTMLMediaElement, source: string): () => void {
  const comma = source.indexOf(",");
  if (comma < 0) throw new Error("Invalid video data URL");
  const fragment = source.indexOf("#");
  const header = source.slice(5, comma);
  const payload = source.slice(comma + 1, fragment < 0 ? undefined : fragment);
  const bytes = mediaDataBytes(payload, /;base64/iu.test(header));
  const mime = /^data:([^;,]+)/iu.exec(source)?.[1]?.toLowerCase() ?? "";
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const playbackUrl = url + (fragment < 0 ? "" : source.slice(fragment));
  element.src = playbackUrl;
  return () => {
    if (element.getAttribute("src") === playbackUrl) {
      element.removeAttribute("src");
      element.load();
    }
    URL.revokeObjectURL(url);
  };
}

// Native media handles are mutable platform resources, separate from playback snapshots.
export function seekMedia(element: HTMLMediaElement, time: number) {
  element.currentTime = time;
  return element.currentTime;
}
export function toggleMediaMuted(element: HTMLMediaElement) {
  element.muted = !element.muted;
}
export function setMediaVolume(element: HTMLMediaElement, volume: number) {
  element.volume = volume;
  element.muted = false;
}
export function setMediaPlaybackRate(element: HTMLMediaElement, rate: number) {
  element.playbackRate = rate;
}
