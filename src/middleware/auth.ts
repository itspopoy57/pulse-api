// src/middleware/auth.ts (or auth.ts where you put it)
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AuthRequest extends Request {
  userId?: number;
}

export function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  const token = header.slice("Bearer ".length);

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("JWT_SECRET is not set");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const decoded = jwt.verify(token, secret) as { userId: number };
    (req as any).userId = decoded.userId;
    next();
  } catch (err) {
    console.error("Auth error:", err);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
