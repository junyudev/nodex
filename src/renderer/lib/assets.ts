import { parseAssetSource } from "../../shared/assets";
import { toApiUrl } from "./http-base";

const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_RESOURCE_UPLOAD_BYTES = 64 * 1024 * 1024;

interface UploadImageResponse {
  source?: string;
  error?: string;
}

export interface UploadedResourceAssetResponse {
  source?: string;
  name?: string;
  mimeType?: string;
  bytes?: number;
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

export async function uploadResourceAsset(
  file: File,
): Promise<Required<Pick<UploadedResourceAssetResponse, "source" | "name" | "mimeType" | "bytes">>> {
  if (file.size > MAX_RESOURCE_UPLOAD_BYTES) {
    throw new Error("Resource exceeds 64MB upload limit");
  }

  const formData = new FormData();
  formData.set("file", file);

  const response = await fetch(toApiUrl("/api/assets/resources"), {
    method: "POST",
    body: formData,
  });

  const body = (await response.json()) as UploadedResourceAssetResponse;
  if (!response.ok) {
    throw new Error(body.error || "Resource upload failed");
  }
  if (!body.source || !body.name || !body.mimeType || typeof body.bytes !== "number") {
    throw new Error("Resource upload response is missing fields");
  }

  return {
    source: body.source,
    name: body.name,
    mimeType: body.mimeType,
    bytes: body.bytes,
  };
}

export async function materializeLocalResourceAsset(
  localPath: string,
): Promise<Required<Pick<UploadedResourceAssetResponse, "source" | "name" | "mimeType" | "bytes">>> {
  const response = await fetch(toApiUrl("/api/assets/resources"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPath }),
  });

  const body = (await response.json()) as UploadedResourceAssetResponse;
  if (!response.ok) {
    throw new Error(body.error || "Resource materialization failed");
  }
  if (!body.source || !body.name || !body.mimeType || typeof body.bytes !== "number") {
    throw new Error("Resource materialization response is missing fields");
  }

  return {
    source: body.source,
    name: body.name,
    mimeType: body.mimeType,
    bytes: body.bytes,
  };
}
