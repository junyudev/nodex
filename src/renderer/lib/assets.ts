import { parseAssetSource } from "../../shared/assets";
import { toApiUrl } from "./http-base";

const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

interface UploadImageResponse {
  source?: string;
  error?: string;
}

export function resolveAssetSourceToHttpUrl(source: string): string {
  const parsed = parseAssetSource(source);
  if (!parsed) return source;

  const fileName = encodeURIComponent(parsed.fileName);
  return toApiUrl(`/api/assets/${fileName}`);
}

export async function uploadImageAsset(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image exceeds 10MB upload limit");
  }

  const formData = new FormData();
  formData.set("file", file);

  const response = await fetch(
    toApiUrl("/api/assets/images"),
    {
      method: "POST",
      body: formData,
    },
  );

  const body = (await response.json()) as UploadImageResponse;

  if (!response.ok) {
    throw new Error(body.error || "Image upload failed");
  }

  if (!body.source) {
    throw new Error("Image upload response is missing source");
  }

  return body.source;
}
