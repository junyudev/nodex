export async function writeTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
    return false;
  }

  await navigator.clipboard.writeText(text);
  return true;
}
