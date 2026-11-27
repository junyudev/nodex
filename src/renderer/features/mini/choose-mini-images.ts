import { getIntl } from "@/lib/i18n";
import { pickComposerFiles } from "../local-conversation/composer-context-operations";

/**
 * Mini picks images through Main, which keeps the panel composing while the
 * picker is open; a browser chooser would take the keyboard and close it.
 */
export async function chooseMiniImages(): Promise<readonly File[]> {
  const picked = await pickComposerFiles({
    imagesOnly: true,
    title: getIntl().formatMessage({
      id: "components.messageImagesInput.addPhotos",
      defaultMessage: "Add photos",
    }),
  });
  return picked.flatMap((file) => {
    if (!file.imageDataUrl || !file.mimeType) return [];
    const base64 = file.imageDataUrl.slice(file.imageDataUrl.indexOf(",") + 1);
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return [new File([bytes], file.label, { type: file.mimeType })];
  });
}
