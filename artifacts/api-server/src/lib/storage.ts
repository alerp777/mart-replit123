import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { logger } from "./logger.js";

const STORAGE_BUCKET_URL = process.env["STORAGE_BUCKET_URL"];
const STORAGE_ACCESS_KEY = process.env["STORAGE_ACCESS_KEY"];
const STORAGE_SECRET_KEY = process.env["STORAGE_SECRET_KEY"];
const STORAGE_BUCKET_NAME = process.env["STORAGE_BUCKET_NAME"];
const STORAGE_ENDPOINT = process.env["STORAGE_ENDPOINT"];
const STORAGE_REGION = process.env["STORAGE_REGION"] ?? "us-east-1";

export const LOCAL_UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

let s3Client: S3Client | null = null;
let resolvedBucketName: string | null = null;
let resolvedPublicBase: string | null = null;

if (STORAGE_BUCKET_URL) {
  try {
    const parsedUrl = new URL(STORAGE_BUCKET_URL);

    resolvedPublicBase = STORAGE_BUCKET_URL.replace(/\/$/, "");

    if (STORAGE_BUCKET_NAME) {
      resolvedBucketName = STORAGE_BUCKET_NAME;
    } else {
      const pathSegment = parsedUrl.pathname.replace(/^\//, "").split("/")[0];
      resolvedBucketName = pathSegment || null;
    }

    const endpoint = STORAGE_ENDPOINT ?? `${parsedUrl.protocol}//${parsedUrl.host}`;

    if (!resolvedBucketName) {
      logger.warn("[storage] STORAGE_BUCKET_URL is set but bucket name could not be determined. " +
        "Set STORAGE_BUCKET_NAME explicitly or use a path-style URL (e.g. https://endpoint/bucket).");
    } else if (!STORAGE_ACCESS_KEY || !STORAGE_SECRET_KEY) {
      logger.warn("[storage] STORAGE_BUCKET_URL is set but STORAGE_ACCESS_KEY or STORAGE_SECRET_KEY is missing. " +
        "Files will fall back to local disk storage.");
    } else {
      s3Client = new S3Client({
        region: STORAGE_REGION,
        endpoint,
        credentials: {
          accessKeyId: STORAGE_ACCESS_KEY,
          secretAccessKey: STORAGE_SECRET_KEY,
        },
        forcePathStyle: true,
      });
      logger.info(`[storage] S3-compatible storage enabled. Bucket: ${resolvedBucketName}, Endpoint: ${endpoint}`);
    }
  } catch (err) {
    logger.warn({ err }, "[storage] Failed to parse STORAGE_BUCKET_URL — falling back to local disk storage.");
  }
} else if (process.env["NODE_ENV"] !== "production") {
  logger.info("[storage] STORAGE_BUCKET_URL not set — using local disk storage (./uploads/).");
}

async function ensureLocalDir(): Promise<void> {
  await mkdir(LOCAL_UPLOADS_DIR, { recursive: true });
}

export function isS3Enabled(): boolean {
  return s3Client !== null && resolvedBucketName !== null;
}

export async function storageUpload(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  if (s3Client && resolvedBucketName && resolvedPublicBase) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: resolvedBucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
      }),
    );
    return `${resolvedPublicBase}/${key}`;
  }

  await ensureLocalDir();
  await writeFile(path.join(LOCAL_UPLOADS_DIR, key), buffer);
  return `/api/uploads/${key}`;
}
