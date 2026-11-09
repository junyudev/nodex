import { describe, expect, it } from "vitest";

import { REPLY_PICTURE_MAX_HEIGHT, replyPictureBox } from "./reply-picture";

describe("replyPictureBox", () => {
  it("fills the column at the picture's own shape", () => {
    expect(replyPictureBox(350, { width: 256, height: 256 })).toEqual({ width: 350, height: 350 });
    expect(replyPictureBox(350, { width: 1600, height: 900 })).toEqual({
      width: 350,
      height: 196.875,
    });
  });

  it("narrows a tall picture to its shape at the height cap", () => {
    expect(replyPictureBox(350, { width: 1170, height: 2532 })).toEqual({
      width: REPLY_PICTURE_MAX_HEIGHT * (1170 / 2532),
      height: REPLY_PICTURE_MAX_HEIGHT,
    });
    // A wide column meets the cap sooner, even for a square.
    expect(replyPictureBox(700, { width: 10, height: 10 })).toEqual({
      width: REPLY_PICTURE_MAX_HEIGHT,
      height: REPLY_PICTURE_MAX_HEIGHT,
    });
  });

  it("holds the place at a photo's shape until the picture's size is known", () => {
    expect(replyPictureBox(360, null)).toEqual({ width: 360, height: 270 });
    expect(replyPictureBox(360, { width: 0, height: 0 })).toEqual({ width: 360, height: 270 });
  });

  it("shows an extreme shape letterboxed rather than as a sliver", () => {
    expect(replyPictureBox(400, { width: 8000, height: 100 })).toEqual({ width: 400, height: 100 });
    expect(replyPictureBox(400, { width: 100, height: 8000 })).toEqual({
      width: REPLY_PICTURE_MAX_HEIGHT / 4,
      height: REPLY_PICTURE_MAX_HEIGHT,
    });
  });

  it("has no box before the column is measured", () => {
    expect(replyPictureBox(0, { width: 256, height: 256 })).toEqual({ width: 0, height: 0 });
  });
});
