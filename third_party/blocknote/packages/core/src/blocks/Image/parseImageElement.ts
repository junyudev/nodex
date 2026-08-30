export const parseImageElement = (imageElement: HTMLImageElement) => {
  const url = imageElement.src || undefined;
  const name = imageElement.alt || undefined;

  const sourceWidth = Number.parseInt(
    imageElement.dataset.sourceWidth ?? imageElement.getAttribute("width") ?? "",
    10,
  );
  const sourceHeight = Number.parseInt(
    imageElement.dataset.sourceHeight ?? imageElement.getAttribute("height") ?? "",
    10,
  );
  const hasSourceDimensions =
    Number.isFinite(sourceWidth) &&
    sourceWidth > 0 &&
    Number.isFinite(sourceHeight) &&
    sourceHeight > 0;
  const explicitPreviewWidth = Number.parseInt(imageElement.dataset.previewWidth ?? "", 10);
  const previewWidth =
    Number.isFinite(explicitPreviewWidth) && explicitPreviewWidth > 0
      ? explicitPreviewWidth
      : hasSourceDimensions
        ? undefined
        : imageElement.width || undefined;

  return {
    url,
    previewWidth,
    name,
    ...(hasSourceDimensions ? { sourceWidth, sourceHeight } : {}),
  };
};
