// src/routes/auth.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimit"; // ✅ NEW

const router = Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// small helper so we never leak which one failed
function authError(res: any) {
  return res
    .status(400)
    .json({ error: "Invalid email or password." });
}

function buildUserPayload(user: any) {
  return {
    id: String(user.id),
    email: user.email,
    username: user.username,
    region: user.region,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    avatarUrl: user.avatarUrl ?? null,
    isAdmin: user.isAdmin ?? false,
    isBanned: user.isBanned ?? false,
    createdAt: user.createdAt.toISOString(),
  };
}

// ---------- REGISTER ----------
// POST /auth/register
router.post("/register", authLimiter, async (req, res) => {   // 👈 added authLimiter
  try {
    const body = req.body ?? {};
    const email = (body.email ?? "").toString().trim().toLowerCase();
    const password = (body.password ?? "").toString();
    const usernameRaw = body.username ?? null;
    const regionRaw = body.region ?? null;

    const username =
      typeof usernameRaw === "string" ? usernameRaw.trim() : null;
    const region =
      typeof regionRaw === "string" ? regionRaw.trim() : null;

    // ---- validation ----
    if (!email || !EMAIL_REGEX.test(email)) {
      return res
        .status(400)
        .json({ error: "Please enter a valid email address." });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters.",
      });
    }

    if (password.length > 100) {
      return res.status(400).json({
        error: "Password is too long.",
      });
    }

    if (username && username.length > 24) {
      return res.status(400).json({
        error: "Username must be at most 24 characters.",
      });
    }

    if (region && region.length > 40) {
      return res.status(400).json({
        error: "Region label must be at most 40 characters.",
      });
    }

    // check if email already used
    const existingEmail = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });

    if (existingEmail) {
      return res
        .status(400)
        .json({ error: "That email is already registered." });
    }

    if (username) {
      const existingUsername = await prisma.user.findUnique({
        where: { username },
        select: { id: true },
      });
      if (existingUsername) {
        return res
          .status(400)
          .json({ error: "That username is already taken." });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        username: username || null,
        region: region || null,
      },
    });

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("JWT_SECRET missing");
      return res.status(500).json({
        error: "Server misconfigured.",
      });
    }

    const token = jwt.sign({ userId: user.id }, secret, {
      expiresIn: "30d",
    });

    return res.json({
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("POST /auth/register error:", err);
    return res
      .status(500)
      .json({ error: "Failed to register. Try again." });
  }
});

// ---------- LOGIN ----------
// POST /auth/login
router.post("/login", authLimiter, async (req, res) => {      // 👈 added authLimiter
  try {
    const body = req.body ?? {};
    const email = (body.email ?? "").toString().trim().toLowerCase();
    const password = (body.password ?? "").toString();

    if (!email || !password) {
      return authError(res);
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      return authError(res);
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      return authError(res);
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("JWT_SECRET missing");
      return res.status(500).json({
        error: "Server misconfigured.",
      });
    }

    const token = jwt.sign({ userId: user.id }, secret, {
      expiresIn: "30d",
    });

    return res.json({
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("POST /auth/login error:", err);
    return res
      .status(500)
      .json({ error: "Failed to login. Try again." });
  }
});

// ---------- ME ----------
// GET /auth/me
router.get("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    return res.json({ user: buildUserPayload(user) });
  } catch (err) {
    console.error("GET /auth/me error:", err);
    return res
      .status(500)
      .json({ error: "Failed to load current user." });
  }
});

// ---------- UPDATE PROFILE BASIC ----------
// PATCH /auth/me
router.patch("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body ?? {};
    const displayName =
      typeof body.displayName === "string"
        ? body.displayName.trim()
        : undefined;
    const bio =
      typeof body.bio === "string" ? body.bio.trim() : undefined;
    const region =
      typeof body.region === "string" ? body.region.trim() : undefined;
    const avatarUrl =
      typeof body.avatarUrl === "string"
        ? body.avatarUrl.trim()
        : undefined;

    const data: any = {};

    if (displayName !== undefined) {
      if (displayName.length > 40) {
        return res.status(400).json({
          error: "Display name must be at most 40 characters.",
        });
      }
      data.displayName = displayName || null;
    }

    if (bio !== undefined) {
      if (bio.length > 280) {
        return res.status(400).json({
          error: "Bio must be at most 280 characters.",
        });
      }
      data.bio = bio || null;
    }

    if (region !== undefined) {
      if (region.length > 40) {
        return res.status(400).json({
          error: "Region must be at most 40 characters.",
        });
      }
      data.region = region || null;
    }

    if (avatarUrl !== undefined) {
      data.avatarUrl = avatarUrl || null;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
    });

    return res.json({ user: buildUserPayload(user) });
  } catch (err) {
    console.error("PATCH /auth/me error:", err);
    return res
      .status(500)
      .json({ error: "Failed to update profile." });
  }
});

export default router;
