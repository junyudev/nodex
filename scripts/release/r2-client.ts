import { AwsClient } from "aws4fetch";

const R2_ENDPOINT = "https://3651f9ccc104912e0f466f6bb13ce230.r2.cloudflarestorage.com";

export const r2BucketUrl = (bucket: string): string => `${R2_ENDPOINT}/${bucket}`;

export function createR2Client(missingCredentials: string): AwsClient {
  const { R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!accessKeyId || !secretAccessKey) throw new Error(missingCredentials);
  return new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
}
