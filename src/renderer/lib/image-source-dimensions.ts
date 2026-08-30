import {
  normalizeImageSourceDimensions,
  type ImageSourceDimensions,
} from "../../shared/image-layout";

async function readWithImageBitmap(file: File): Promise<ImageSourceDimensions | null> {
  if (typeof createImageBitmap !== "function") return null;

  const bitmap = await createImageBitmap(file);
  try {
    return normalizeImageSourceDimensions(bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function readWithImageElement(file: File): Promise<ImageSourceDimensions | null> {
  if (
    typeof Image === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return Promise.resolve(null);
  }

  const objectUrl = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const image = new Image();
    const finish = (dimensions: ImageSourceDimensions | null) => {
      image.removeEventListener("load", handleLoad);
      image.removeEventListener("error", handleError);
      URL.revokeObjectURL(objectUrl);
      resolve(dimensions);
    };
    const handleLoad = () =>
      finish(normalizeImageSourceDimensions(image.naturalWidth, image.naturalHeight));
    const handleError = () => finish(null);

    image.addEventListener("load", handleLoad);
    image.addEventListener("error", handleError);
    image.src = objectUrl;
  });
}

/** Reads intrinsic image geometry before the uploaded URL becomes the document placement. */
export async function readImageFileSourceDimensions(
  file: File,
): Promise<ImageSourceDimensions | null> {
  if (!file.type.toLowerCase().startsWith("image/")) return null;

  try {
    const dimensions = await readWithImageBitmap(file);
    if (dimensions) return dimensions;
  } catch {
    // Chromium may reject formats that an HTMLImageElement can still decode.
  }

  try {
    return await readWithImageElement(file);
  } catch {
    return null;
  }
}
