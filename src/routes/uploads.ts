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

    // Return permanent public URL instead of signed URL
    const publicUrl = `https://storage.googleapis.com/${bucketName}/${objectKey}`;

    res.json({ uploadUrl, publicUrl, objectKey });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "sign failed" });
  }
});

export default router;
