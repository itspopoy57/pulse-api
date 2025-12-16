// src/middleware/rateLimit.ts
import type { Request, Response } from "express";
import rateLimit, {
  ipKeyGenerator,
  type ValueDeterminingMiddleware,
} from "express-rate-limit";

// Helper: prefer per-user limiting (when authMiddleware has set req.userId),
// otherwise fall back to IP using the library helper for IPv6 safety.
const userOrIpKey: ValueDeterminingMiddleware<string> = (
  req: Request,
  res: Response
) => {
  const anyReq = req as any;
  if (anyReq.userId) {
    return String(anyReq.userId);
  }

  // ✅ make sure we always pass a string to ipKeyGenerator
  const ip = typeof req.ip === "string" && req.ip.length > 0
    ? req.ip
    : "0.0.0.0";

  return ipKeyGenerator(ip);
};

// Base options shared by all limiters
const baseOptions = {
  standardHeaders: "draft-7" as const,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
};

// Generic limiter for “most” routes (per user/IP)
export const genericLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000, // 1 minute
  limit: 120, // 120 req/min
  message: { error: "Too many requests. Please slow down." },
});

// Stricter limiter for auth routes
export const authLimiter = rateLimit({
  ...baseOptions,
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  message: { error: "Too many auth attempts. Try again later." },
});

// Generic “write” limiter (posting, voting, commenting, etc.)
export const writeLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 1000, // 1 minute
  limit: 60,
  message: { error: "You’re doing too many actions. Slow down a bit." },
});

// Limiter for creating posts (per user)
export const createPostLimiter = rateLimit({
  ...baseOptions,
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 20, // 20 posts per hour per user
  message: { error: "You’re posting too fast. Please slow down." },
});

// Limiter for creating comments (per user)
export const commentLimiter = rateLimit({
  ...baseOptions,
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 30, // 30 comments / 10 minutes / user
  message: {
    error:
      "You’re commenting too fast. Please slow down a little before adding more comments.",
  },
});
