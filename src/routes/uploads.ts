import { Router } from "express";
import { Storage } from "@google-cloud/storage";

const router = Router();
const storage = new Storage();

router.get("/sign", async (req, res) => {
  try {
    const bucketName = process.env.BUCKET_NAME;
    if (!bucketName) return res.status(500).json({ error: "BUCKET_NAME missing" });

    const contentType = (req.query.contentType as string) || "image/jpeg";
    const ext = contentType.includes("png") ? "png" : "jpg";

    const objectKey = `uploads/${Date.now()}.${ext}`;
    const file = storage.bucket(bucketName).file(objectKey);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 10 * 60 * 1000, // 10 min
      contentType,
    });

    const [readUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    res.json({ uploadUrl, readUrl, objectKey, bucketName });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "sign failed" });
  }
});

export default router;
