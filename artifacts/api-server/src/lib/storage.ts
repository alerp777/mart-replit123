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
const IS_PROD = process.env["NODE_ENV"] === "production";

export const LOCAL_UPLOADS_DIR = path.resolve(process.cwd(), "uploads");

let s3Client: S3Client | null = null;
let resolvedBucketName: string | null = null;
let resolvedPublicBase: string | null = null;

/* ── URL parsing ────────────────────────────────────────────────────────────
   Handles two common S3-compatible URL styles:
   • Path-style:         https://s3.amazonaws.com/my-bucket
   • Virtual-host style: https://my-bucket.s3.amazonaws.com
                         https://my-bucket.nyc3.digitaloceanspaces.com
   In both cases, bucket name is derived and the endpoint is the bare host
   (without the bucket prefix) so forcePathStyle works correctly for the SDK. */
function parseBucketUrl(rawUrl: string): { bucket: string | null; endpoint: string } {
  const url = new URL(rawUrl);

  const pathSegment = url.pathname.replace(/^\//, "").split("/")[0];
  if (pathSegment) {
    /* Path-style: bucket is the first path segment */
    return { bucket: pathSegment, endpoint: `${url.protocol}//${url.host}` };
  }

  /* Virtual-hosted style: bucket is the first subdomain */
  const hostParts = url.hostname.split(".");
  if (hostParts.length >= 3) {
    const bucket = hostParts[0]!;
    const endpointHost = hostParts.slice(1).join(".");
    return { bucket, endpoint: `${url.protocol}//${endpointHost}` };
  }

  return { bucket: null, endpoint: `${url.protocol}//${url.host}` };
}

if (STORAGE_BUCKET_URL) {
  let initError: Error | null = null;

  try {
    const { bucket: derivedBucket, endpoint: derivedEndpoint } = parseBucketUrl(STORAGE_BUCKET_URL);
    resolvedBucketName = STORAGE_BUCKET_NAME ?? derivedBucket;
    resolvedPublicBase = STORAGE_BUCKET_URL.replace(/\/$/, "");

    const endpoint = STORAGE_ENDPOINT ?? derivedEndpoint;

    const missingVars: string[] = [];
    if (!resolvedBucketName) missingVars.push("STORAGE_BUCKET_NAME (cannot auto-detect from URL — use path-style or virtual-host URL)");
    if (!STORAGE_ACCESS_KEY) missingVars.push("STORAGE_ACCESS_KEY");
    if (!STORAGE_SECRET_KEY) missingVars.push("STORAGE_SECRET_KEY");

    if (missingVars.length > 0) {
      initError = new Error(
        `[storage] STORAGE_BUCKET_URL is set but the following S3 configuration is missing: ${missingVars.join(", ")}`,
      );
    } else {
      s3Client = new S3Client({
        region: STORAGE_REGION,
        endpoint,
        credentials: {
          accessKeyId: STORAGE_ACCESS_KEY!,
          secretAccessKey: STORAGE_SECRET_KEY!,
        },
        forcePathStyle: true,
      });
      logger.info(`[storage] S3-compatible storage enabled. Bucket: ${resolvedBucketName}, Endpoint: ${endpoint}`);
    }
  } catch (err) {
    initError = err instanceof Error ? err : new Error(String(err));
  }

  if (initError) {
    if (IS_PROD) {
      /* Fatal in production — local disk is not a safe fallback */
      throw new Error(
        `${initError.message}. Cannot use local disk as a fallback in production: files will not survive container restarts.`,
      );
    }
    /* Development: warn and fall back to local disk */
    logger.warn({ err: initError }, "[storage] S3 config incomplete — falling back to local disk storage in development.");
    resolvedBucketName = null;
    s3Client = null;
  }
} else if (!IS_PROD) {
  logger.info("[storage] STORAGE_BUCKET_URL not set — using local disk storage (./uploads/).");
}
/* In production without STORAGE_BUCKET_URL the startup guard in uploads.ts
   already throws before this module's side-effects matter. */

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

  /* Guard: local disk must never be used in production */
  if (IS_PROD) {
    throw new Error(
      "[storage] storageUpload called in production without a working S3 client. " +
      "Set STORAGE_BUCKET_URL, STORAGE_ACCESS_KEY, and STORAGE_SECRET_KEY.",
    );
  }

  await ensureLocalDir();
  await writeFile(path.join(LOCAL_UPLOADS_DIR, key), buffer);
  return `/api/uploads/${key}`;
}
