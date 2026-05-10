import { Router, type IRouter } from "express";
import { randomUUID } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import multer from "multer";
import sharp from "sharp";
import { sendSuccess, sendCreated, sendError, sendNotFound, sendValidationError } from "../lib/response.js";
import { customerAuth, riderAuth, requireRole, getCachedSettings } from "../middleware/security.js";
import { db } from "@workspace/db";
import { pharmacyPrescriptionRefsTable } from "@workspace/db/schema";
import { logger } from "../lib/logger.js";
import { storageUpload } from "../lib/storage.js";

const execFileAsync = promisify(execFile);

const router: IRouter = Router();

/* ── Production disk-storage warning ────────────────────────────────────────
   Files are stored on local disk inside ./uploads/ as a dev fallback.
   In production, set STORAGE_BUCKET_URL + STORAGE_ACCESS_KEY +
   STORAGE_SECRET_KEY to enable S3-compatible object storage. */
if (process.env.NODE_ENV === "production" && !process.env["STORAGE_BUCKET_URL"]) {
  throw new Error(
    "[uploads] FATAL: Running in production without object storage. " +
    "Files stored in ./uploads/ will be lost on container restart and are " +
    "not shared across instances. Set STORAGE_BUCKET_URL (S3-compatible) " +
    "in your environment before deploying to production.",
  );
}

const DEFAULT_MAX_IMAGE_MB = 5;
const DEFAULT_MAX_VIDEO_MB = 50;
const DEFAULT_MAX_VIDEO_DURATION_SECS = 60;
const DEFAULT_IMAGE_FORMATS = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
const DEFAULT_VIDEO_FORMATS = ["video/mp4", "video/quicktime", "video/webm"];

function formatToMime(fmt: string): string {
  const f = fmt.trim().toLowerCase();
  if (f === "jpg" || f === "jpeg") return "image/jpeg";
  if (f === "png") return "image/png";
  if (f === "webp") return "image/webp";
  if (f === "mp4") return "video/mp4";
  if (f === "quicktime" || f === "mov") return "video/quicktime";
  if (f === "webm") return "video/webm";
  return f.includes("/") ? f : `image/${f}`;
}

async function getUploadLimits() {
  const s = await getCachedSettings();
  const maxImageMb = parseInt(s["upload_max_image_mb"] ?? String(DEFAULT_MAX_IMAGE_MB)) || DEFAULT_MAX_IMAGE_MB;
  const maxVideoMb = parseInt(s["upload_max_video_mb"] ?? String(DEFAULT_MAX_VIDEO_MB)) || DEFAULT_MAX_VIDEO_MB;
  const maxVideoDuration = parseInt(s["upload_max_video_duration_sec"] ?? String(DEFAULT_MAX_VIDEO_DURATION_SECS)) || DEFAULT_MAX_VIDEO_DURATION_SECS;
  const imageFormats = s["upload_allowed_image_formats"]
    ? s["upload_allowed_image_formats"].split(",").map(formatToMime).filter(Boolean)
    : DEFAULT_IMAGE_FORMATS;
  const videoFormats = s["upload_allowed_video_formats"]
    ? s["upload_allowed_video_formats"].split(",").map(formatToMime).filter(Boolean)
    : DEFAULT_VIDEO_FORMATS;
  return {
    maxImageSize: maxImageMb * 1024 * 1024,
    maxVideoSize: maxVideoMb * 1024 * 1024,
    maxVideoDuration,
    imageFormats: imageFormats.length ? imageFormats : DEFAULT_IMAGE_FORMATS,
    videoFormats: videoFormats.length ? videoFormats : DEFAULT_VIDEO_FORMATS,
  };
}

/* ── Magic-byte (file signature) validation ─────────────────────────────────
   Prevents MIME-type spoofing by checking the actual file header bytes rather
   than trusting the Content-Type header. */
const MAGIC_BYTES: Record<string, ReadonlyArray<readonly number[]>> = {
  "image/jpeg": [[0xFF, 0xD8, 0xFF]],
  "image/jpg":  [[0xFF, 0xD8, 0xFF]],
  "image/png":  [[0x89, 0x50, 0x4E, 0x47]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]], /* RIFF header — WebP specific check below */
  "video/mp4":  [[0x66, 0x74, 0x79, 0x70]], /* ftyp box at offset 4 */
  "video/quicktime": [[0x66, 0x74, 0x79, 0x70]],
  "video/webm": [[0x1A, 0x45, 0xDF, 0xA3]],
};

function validateFileMagicBytes(buffer: Buffer, mimeType: string): boolean {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) return true; /* Unknown type — pass through (MIME filter handles it) */

  const normalizedMime = mimeType === "image/jpg" ? "image/jpeg" : mimeType;

  for (const sig of signatures) {
    const offset = (normalizedMime === "video/mp4" || normalizedMime === "video/quicktime") ? 4 : 0;
    if (buffer.length < offset + sig.length) continue;
    if (sig.every((byte, i) => buffer[offset + i] === byte)) {
      if (normalizedMime === "image/webp") {
        /* WebP must also have 'WEBP' at bytes 8-11 */
        if (buffer.length < 12) return false;
        return buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
      }
      return true;
    }
  }
  return false;
}

const prescriptionRefMap = new Map<string, string>();

const MULTER_PERMISSIVE_IMAGE_LIMIT = 50 * 1024 * 1024;
const MULTER_PERMISSIVE_VIDEO_LIMIT = 500 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_PERMISSIVE_IMAGE_LIMIT },
});

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_PERMISSIVE_VIDEO_LIMIT },
});

/* ── Helper: optionally compress an image buffer based on platform settings ── */
async function maybeCompressImage(buffer: Buffer, mimeType: string): Promise<Buffer> {
  try {
    const s = await getCachedSettings();
    const compressEnabled = (s["security_compress_images"] ?? "on") === "on";
    if (!compressEnabled) return buffer;
    const quality = Math.max(1, Math.min(100, parseInt(s["security_img_quality"] ?? "80", 10) || 80));
    let pipeline = sharp(buffer);
    if (mimeType === "image/png") {
      pipeline = pipeline.png({ quality, compressionLevel: 6 });
    } else if (mimeType === "image/webp") {
      pipeline = pipeline.webp({ quality });
    } else {
      pipeline = pipeline.jpeg({ quality, mozjpeg: true });
    }
    return await pipeline.toBuffer();
  } catch {
    return buffer;
  }
}

/* ── Helper: upload an image buffer and return the public URL ── */
async function saveBuffer(buffer: Buffer, prefix: string, mimeType: string): Promise<string> {
  const ext = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
  const key = `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const processed = await maybeCompressImage(buffer, mimeType);
  return storageUpload(processed, key, mimeType);
}

/* ── Helper: upload a video buffer and return the public URL ── */
async function saveVideoBuffer(buffer: Buffer, prefix: string, mimeType: string): Promise<string> {
  const ext = mimeType === "video/quicktime" ? ".mov" : mimeType === "video/webm" ? ".webm" : ".mp4";
  const key = `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  return storageUpload(buffer, key, mimeType);
}

/* ── Helper: upload an audio buffer and return the public URL ── */
async function saveAudioBuffer(buffer: Buffer, mimeType: string): Promise<string> {
  const baseType = mimeType.split(";")[0]!.trim();
  const ext =
    baseType === "audio/mpeg" ? ".mp3"
    : baseType === "audio/ogg" ? ".ogg"
    : baseType === "audio/wav" ? ".wav"
    : baseType === "audio/aac" ? ".aac"
    : baseType === "audio/mp4" ? ".m4a"
    : ".webm";
  const key = `audio_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  return storageUpload(buffer, key, baseType);
}

/* ── POST /uploads — JSON base64 upload (customers / super-app) ── */
router.post("/", customerAuth, async (req, res) => {
  try {
    const { file, filename, mimeType } = req.body;

    if (!file) {
      sendValidationError(res, "No file data provided");
      return;
    }

    const limits = await getUploadLimits();
    const mime = mimeType || "image/jpeg";
    if (!limits.imageFormats.includes(mime)) {
      sendValidationError(res, "Only JPEG, PNG, and WebP images are allowed");
      return;
    }

    const base64Data = file.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    if (buffer.length > limits.maxImageSize) {
      sendValidationError(res, `File too large. Maximum ${Math.round(limits.maxImageSize / 1024 / 1024)}MB allowed`);
      return;
    }

    if (!validateFileMagicBytes(buffer, mime)) {
      sendValidationError(res, "File content does not match the declared MIME type");
      return;
    }

    const url = await saveBuffer(buffer, "upload", mime);

    sendCreated(res, {
      url,
      filename: filename || path.basename(url),
      size: buffer.length,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    sendError(res, msg);
  }
});

/* ── POST /uploads/proof — multipart/form-data delivery-proof upload (riders) ──
   Uses riderAuth so rider JWTs are accepted.
   File field name: "file"; optional field "purpose" for auditing.
   Enforces same 5MB / allowed-type limits as the JSON route.
*/
router.post(
  "/proof",
  riderAuth,
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          sendValidationError(res, "File too large");
          return;
        }
        sendValidationError(res, err.message);
        return;
      }
      if (err) {
        sendValidationError(res, err instanceof Error ? err.message : "Upload failed");
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        sendValidationError(res, "No file uploaded");
        return;
      }

      const { mimetype, buffer, originalname } = req.file;

      const limits = await getUploadLimits();
      if (!limits.imageFormats.includes(mimetype)) {
        sendValidationError(res, "Only JPEG, PNG, and WebP images are allowed");
        return;
      }
      if (buffer.length > limits.maxImageSize) {
        sendValidationError(res, `File too large. Maximum ${Math.round(limits.maxImageSize / (1024*1024))}MB allowed`);
        return;
      }

      if (!validateFileMagicBytes(buffer, mimetype)) {
        sendValidationError(res, "File content does not match the declared MIME type");
        return;
      }

      const url = await saveBuffer(buffer, "proof", mimetype);

      sendCreated(res, {
        url,
        filename: originalname || path.basename(url),
        size: buffer.length,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      sendError(res, msg);
    }
  },
);

/* ── POST /uploads/register — multipart/form-data upload for registration documents (unauthenticated) ──
   Used during rider/vendor registration before the user has a JWT.
   Same 5MB / allowed-type limits as other upload routes.
*/
router.post(
  "/register",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          sendValidationError(res, "File too large");
          return;
        }
        sendValidationError(res, err.message);
        return;
      }
      if (err) {
        sendValidationError(res, err instanceof Error ? err.message : "Upload failed");
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        sendValidationError(res, "No file uploaded");
        return;
      }

      const { mimetype, buffer, originalname } = req.file;

      const limits = await getUploadLimits();
      if (!limits.imageFormats.includes(mimetype)) {
        sendValidationError(res, "Only JPEG, PNG, and WebP images are allowed");
        return;
      }
      if (buffer.length > limits.maxImageSize) {
        sendValidationError(res, `File too large. Maximum ${Math.round(limits.maxImageSize / (1024*1024))}MB allowed`);
        return;
      }

      if (!validateFileMagicBytes(buffer, mimetype)) {
        sendValidationError(res, "File content does not match the declared MIME type");
        return;
      }

      const url = await saveBuffer(buffer, "reg", mimetype);

      sendCreated(res, {
        url,
        filename: originalname || path.basename(url),
        size: buffer.length,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      sendError(res, msg);
    }
  },
);

/* ── POST /uploads/prescription — base64 prescription upload (customers) ── */
router.post("/prescription", customerAuth, async (req, res) => {
  try {
    const { file, mimeType, refId } = req.body;

    if (!file) {
      sendValidationError(res, "No file data provided");
      return;
    }

    if (!refId || typeof refId !== "string") {
      sendValidationError(res, "refId is required");
      return;
    }

    const limits = await getUploadLimits();
    const mime = mimeType || "image/jpeg";
    if (!limits.imageFormats.includes(mime)) {
      sendValidationError(res, "Only JPEG, PNG, and WebP images are allowed");
      return;
    }

    const base64Data = file.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Data, "base64");

    if (buffer.length > limits.maxImageSize) {
      sendValidationError(res, `File too large. Maximum ${Math.round(limits.maxImageSize / 1024 / 1024)}MB allowed`);
      return;
    }

    if (!validateFileMagicBytes(buffer, mime)) {
      sendValidationError(res, "File content does not match the declared MIME type");
      return;
    }

    const url = await saveBuffer(buffer, "rx", mime);
    prescriptionRefMap.set(refId, url);
    setTimeout(() => prescriptionRefMap.delete(refId), 60 * 60 * 1000);

    const userId = req.customerId;
    if (userId) {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      db.insert(pharmacyPrescriptionRefsTable)
        .values({ refId, userId, photoUrl: url, expiresAt })
        .catch(() => {});
    }

    sendCreated(res, { url, refId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Upload failed";
    sendError(res, msg);
  }
});

router.get("/prescription/resolve/:refId", (req, res) => {
  const url = prescriptionRefMap.get(req.params.refId!);
  if (url) {
    sendSuccess(res, { url });
  } else {
    sendNotFound(res, "Reference not found or expired");
  }
});

/* ── POST /uploads/video — multipart video upload (vendors only) ── */
router.post(
  "/video",
  requireRole("vendor", { vendorApprovalCheck: true }),
  (req, res, next) => {
    videoUpload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          sendValidationError(res, "Video too large. Maximum 50MB allowed");
          return;
        }
        sendValidationError(res, err.message);
        return;
      }
      if (err) {
        sendValidationError(res, err instanceof Error ? err.message : "Upload failed");
        return;
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        sendValidationError(res, "No video file uploaded");
        return;
      }

      const { mimetype, buffer, originalname } = req.file;

      const limits = await getUploadLimits();
      if (!limits.videoFormats.includes(mimetype)) {
        sendValidationError(res, "Only MP4, MOV, and WebM videos are allowed");
        return;
      }
      if (buffer.length > limits.maxVideoSize) {
        sendValidationError(res, `Video too large. Maximum ${Math.round(limits.maxVideoSize / (1024*1024))}MB allowed`);
        return;
      }

      const tmpPath = path.join(os.tmpdir(), `upload_${randomUUID()}.tmp`);
      try {
        await writeFile(tmpPath, buffer);
        const { stdout } = await execFileAsync("ffprobe", [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          tmpPath,
        ]);
        const duration = parseFloat(stdout.trim());
        if (isNaN(duration)) {
          sendValidationError(res, "Could not determine video duration. Please upload a valid video file.");
          return;
        }
        if (duration > limits.maxVideoDuration) {
          sendValidationError(res, `Video must be ${limits.maxVideoDuration} seconds or less. Your video is ${Math.ceil(duration)}s.`);
          return;
        }
      } catch {
        sendValidationError(res, "Could not verify video duration. Please try a different file or format.");
        return;
      } finally {
        unlink(tmpPath).catch(() => {});
      }

      const url = await saveVideoBuffer(buffer, "video", mimetype);

      sendCreated(res, {
        url,
        filename: originalname || path.basename(url),
        size: buffer.length,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Upload failed";
      sendError(res, msg);
    }
  },
);

/* ── POST /uploads/audio — multipart audio upload (authenticated users) ── */
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const ALLOWED_AUDIO_TYPES = ["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/aac"];

router.post(
  "/audio",
  requireRole("vendor", { vendorApprovalCheck: true }),
  (req, res, next) => {
    audioUpload.single("file")(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") { sendValidationError(res, "Audio too large. Maximum 20MB allowed"); return; }
        sendValidationError(res, err.message);
        return;
      }
      if (err) { sendValidationError(res, err instanceof Error ? err.message : "Upload failed"); return; }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) { sendValidationError(res, "No audio file uploaded"); return; }
      const { mimetype, buffer, originalname } = req.file;
      const baseType = mimetype.split(";")[0]!.trim();
      if (!ALLOWED_AUDIO_TYPES.includes(baseType)) {
        sendValidationError(res, "Only webm, ogg, mp3, mp4, wav, and aac audio files are allowed");
        return;
      }
      const url = await saveAudioBuffer(buffer, mimetype);
      sendCreated(res, { url, filename: originalname || path.basename(url), size: buffer.length });
    } catch (e: unknown) {
      sendError(res, e instanceof Error ? e.message : "Audio upload failed");
    }
  },
);

export { prescriptionRefMap };

export default router;
