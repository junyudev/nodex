import { sanitizeNativeSaveFileName } from "../../shared/native-file-save";

const UNTITLED_PAGE = "Untitled";

/** The file a Page downloads as: its title, safe for every supported file system. */
export function pageMarkdownFileName(title: string): string {
  const stem = title.replace(/\s+/g, " ").trim() || UNTITLED_PAGE;
  return sanitizeNativeSaveFileName(`${stem}.md`);
}

/** A downloaded Page reads on its own: its title leads as the one top-level heading. */
export function pageMarkdownFileContents(title: string, bodyMarkdown: string): string {
  const heading = `# ${title.replace(/\s+/g, " ").trim() || UNTITLED_PAGE}`;
  const body = bodyMarkdown.trim();
  return body ? `${heading}\n\n${body}\n` : `${heading}\n`;
}

export function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
