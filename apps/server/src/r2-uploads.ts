import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

let client: S3Client | null = null;

function uploadClient(): S3Client {
  const r2 = config.uploadR2;
  if (!r2.endpoint || !r2.bucket || !r2.accessKeyId || !r2.secretAccessKey) {
    throw new Error("Temporary R2 uploads are not configured");
  }
  client ??= new S3Client({
    region: r2.region,
    endpoint: r2.endpoint,
    maxAttempts: 4,
    credentials: {
      accessKeyId: r2.accessKeyId,
      secretAccessKey: r2.secretAccessKey,
    },
  });
  return client;
}

export function temporaryObjectKey(uploadId: string, fileName: string): string {
  const extension = fileName.toLowerCase().match(/\.(mp4|mov|m4v|webm)$/)?.[0] ?? ".mp4";
  return `${config.uploadR2.prefix}/${uploadId}/source${extension}`;
}

export async function signTemporaryPut(objectKey: string, contentType: string): Promise<string> {
  return getSignedUrl(
    uploadClient(),
    new PutObjectCommand({
      Bucket: config.uploadR2.bucket,
      Key: objectKey,
      ContentType: contentType,
      CacheControl: "private, no-store",
    }),
    { expiresIn: config.uploadR2.urlTtlSeconds },
  );
}

export async function signTemporaryGet(objectKey: string): Promise<string> {
  return getSignedUrl(
    uploadClient(),
    new GetObjectCommand({ Bucket: config.uploadR2.bucket, Key: objectKey }),
    { expiresIn: config.uploadR2.urlTtlSeconds },
  );
}

export async function inspectTemporaryObject(objectKey: string) {
  const result = await uploadClient().send(
    new HeadObjectCommand({ Bucket: config.uploadR2.bucket, Key: objectKey }),
  );
  return {
    sizeBytes: Number(result.ContentLength ?? 0),
    contentType: String(result.ContentType ?? "").split(";")[0]!.trim().toLowerCase(),
    etag: String(result.ETag ?? "").replaceAll('"', ""),
  };
}

export async function deleteTemporaryObject(objectKey: string): Promise<void> {
  await uploadClient().send(
    new DeleteObjectCommand({ Bucket: config.uploadR2.bucket, Key: objectKey }),
  );
}
