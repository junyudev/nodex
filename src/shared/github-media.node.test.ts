import { describe, expect, test } from "vite-plus/test";
import { parseGitHubAttachment, parseGitHubAttachmentCdnUrl } from "./github-media";
import { prepareGitHubAttachmentMarkdown } from "./github-media-markdown";

const id = "23c3c624-f538-4f67-a100-bed566043a1f";
const url = `https://github.com/user-attachments/assets/${id}`;
const legacy = `https://github.com/owner/repo/assets/123/${id}`;
const cdnPath = `/123/456-${id}.png`;
const signed = `https://private-user-images.githubusercontent.com${cdnPath}?jwt=one.two.three`;

describe("GitHub attachment URLs", () => {
  test("reduces canonical, legacy, and CDN URLs to one stable attachment identity", () => {
    for (const value of [
      url,
      legacy,
      signed,
      `https://user-images.githubusercontent.com${cdnPath}`,
    ]) {
      expect(parseGitHubAttachment(value)).toEqual({ id, url });
    }
    expect(parseGitHubAttachmentCdnUrl(url)).toBeNull();
    expect(parseGitHubAttachmentCdnUrl(signed)?.id).toBe(id);
  });

  test.each([
    url.replace("https:", "http:"),
    url.replace("github.com", "github.com.invalid"),
    url.replace("github.com", "github.com:444"),
    url.replace("github.com", "x@github.com"),
    `${url}/more`,
    `${url}?redirect=elsewhere`,
    `https://private-user-images.githubusercontent.com${cdnPath}`,
    signed.replace(cdnPath, `/${id}.png`),
  ])("refuses unrelated or noncanonical locations (%s)", (value) => {
    expect(parseGitHubAttachment(value)).toBeNull();
  });
});

describe("GitHub attachment Markdown", () => {
  test("recognizes Markdown images, HTML media, and an attachment URL on its own line", () => {
    const input = [
      `![Sample](${legacy} "A title")`,
      `A <img width="300" alt='A &quot;quote&quot;' src='${signed}'/> and a <video src="${legacy}"></video>.`,
      `<div><img src="${signed}"></div>`,
      "",
      "Recording:",
      url,
      "After the recording.",
    ].join("\r\n");
    const output = prepareGitHubAttachmentMarkdown(input);
    expect(output).toBe(
      [
        `![Sample](<${url}> "A title")`,
        `A <img width="300" alt='A &quot;quote&quot;' src="${url}"/> and a <img src="${url}" alt="">.`,
        `<div><img src="${url}"></div>`,
        "",
        "Recording:",
        `![](<${url}>)`,
        "After the recording.",
      ].join("\r\n"),
    );
  });

  test("leaves code blocks, spans, non-standalone URLs, and unrelated links alone", () => {
    const input = [
      "~~~markdown",
      `![Sample](${legacy})`,
      url,
      "~~~",
      "",
      `    <img src="${signed}">`,
      `    ${url}`,
      "",
      `> \`\`<img src="${signed}">\`\``,
      "",
      `Visit ${url} for more.`,
      `[A named link](${url})`,
      `[An ordinary image](https://example.com/logo.png)`,
      `<!-- <img src="${signed}"> -->`,
      `<pre><img src="${signed}"></pre>`,
    ].join("\n");
    expect(prepareGitHubAttachmentMarkdown(input)).toBe(input);
  });
});
