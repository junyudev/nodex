export interface PictureSize {
  readonly width: number;
  readonly height: number;
}

/** The tallest a reply's picture stands, so the reply around it stays in view. */
export const REPLY_PICTURE_MAX_HEIGHT = 420;

/** The shape that holds a picture's place until its own size is known: a common photo's. */
const PENDING_SHAPE = 4 / 3;
/** A picture beyond these shapes shows letterboxed in a box of this shape, not as a sliver. */
const TALLEST_SHAPE = 1 / 4;
const WIDEST_SHAPE = 4;

/** Width over height of the box a picture shows in. */
export const replyPictureShape = (picture: PictureSize | null): number =>
  picture && picture.width > 0 && picture.height > 0
    ? Math.min(WIDEST_SHAPE, Math.max(TALLEST_SHAPE, picture.width / picture.height))
    : PENDING_SHAPE;

/**
 * A reply picture's box in a column `column` points wide: the column's full width at the
 * picture's own shape, narrowed to that shape when it would stand taller than the cap. Before its
 * size is known the box holds a photo's shape, at the height the same rule gives, so the reply
 * moves at most once, when the picture arrives.
 */
export const replyPictureBox = (column: number, picture: PictureSize | null): PictureSize => {
  if (!(column > 0)) return { width: 0, height: 0 };
  const shape = replyPictureShape(picture);
  const width = Math.min(column, REPLY_PICTURE_MAX_HEIGHT * shape);
  return { width, height: width / shape };
};
