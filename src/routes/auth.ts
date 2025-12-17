// src/routes/auth.ts
import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { authLimiter } from "../middleware/rateLimit";
import {
  generateVerificationCode,
  getVerificationExpiry,
  sendVerificationEmail,
  isTokenExpired,
} from "../utils/emailVerification";
import { firebaseAdmin } from "../config/firebase";

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
    emailVerified: user.emailVerified ?? false,
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

    // Generate verification code
    const verificationCode = generateVerificationCode();
    const verificationExpiry = getVerificationExpiry();

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        username: username || null,
        region: region || null,
        emailVerified: false,
        verificationToken: verificationCode,
        verificationTokenExpiry: verificationExpiry,
      },
    });

    // Send verification email
    try {
      await sendVerificationEmail(email, verificationCode);
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
      // Don't fail registration if email fails
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
      message: "Registration successful! Please check your email for verification code.",
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

// ---------- SEND VERIFICATION CODE ----------
// POST /auth/send-verification
router.post("/send-verification", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerified: true },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: "Email already verified" });
    }

    // Generate new verification code
    const verificationCode = generateVerificationCode();
    const verificationExpiry = getVerificationExpiry();

    await prisma.user.update({
      where: { id: userId },
      data: {
        verificationToken: verificationCode,
        verificationTokenExpiry: verificationExpiry,
      },
    });

    // Send verification email
    await sendVerificationEmail(user.email, verificationCode);

    return res.json({
      message: "Verification code sent to your email",
    });
  } catch (err) {
    console.error("POST /auth/send-verification error:", err);
    return res.status(500).json({
      error: "Failed to send verification code",
    });
  }
});

// ---------- VERIFY EMAIL ----------
// POST /auth/verify-email
router.post("/verify-email", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ error: "Verification code required" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.emailVerified) {
      return res.status(400).json({ error: "Email already verified" });
    }

    if (!user.verificationToken) {
      return res.status(400).json({
        error: "No verification code found. Please request a new one.",
      });
    }

    if (isTokenExpired(user.verificationTokenExpiry)) {
      return res.status(400).json({
        error: "Verification code expired. Please request a new one.",
      });
    }

    if (user.verificationToken !== code.trim()) {
      return res.status(400).json({ error: "Invalid verification code" });
    }

    // Mark email as verified
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        emailVerified: true,
        verificationToken: null,
        verificationTokenExpiry: null,
      },
    });

    return res.json({
      message: "Email verified successfully!",
      user: buildUserPayload(updatedUser),
    });
  } catch (err) {
    console.error("POST /auth/verify-email error:", err);
    return res.status(500).json({
      error: "Failed to verify email",
    });
  }
});

// ---------- GOOGLE SIGN-IN ----------
// POST /auth/google
router.post("/google", authLimiter, async (req, res) => {
  try {
    const { firebaseToken, idToken } = req.body;
    const tokenToVerify = firebaseToken || idToken;

    if (!tokenToVerify) {
      return res.status(400).json({ error: "Google ID token required" });
    }

    // Verify the Google ID token
    let decodedToken;
    try {
      // Try to verify with Google's public keys
      const { OAuth2Client } = require('google-auth-library');
      const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || '601462324642-2jsu6g831rtch45a0k493auulhhtlp59.apps.googleusercontent.com');
      
      const ticket = await client.verifyIdToken({
        idToken: tokenToVerify,
        audience: process.env.GOOGLE_CLIENT_ID || '601462324642-2jsu6g831rtch45a0k493auulhhtlp59.apps.googleusercontent.com',
      });
      
      decodedToken = ticket.getPayload();
    } catch (error) {
      console.error("Google token verification failed:", error);
      return res.status(401).json({ error: "Invalid Google token" });
    }

    const { email, sub: uid, name } = decodedToken;

    if (!email) {
      return res.status(400).json({ error: "Email not found in Google account" });
    }

    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      // Create new user with Google account
      // Generate a random password hash (user won't use it for Google sign-in)
      const randomPassword = Math.random().toString(36).slice(-12);
      const passwordHash = await bcrypt.hash(randomPassword, 10);

      // Extract username from email or name
      let username = name?.split(' ')[0]?.toLowerCase() || email.split('@')[0];
      
      // Ensure username is unique
      const existingUsername = await prisma.user.findUnique({
        where: { username },
      });
      
      if (existingUsername) {
        username = `${username}${Math.floor(Math.random() * 10000)}`;
      }

      user = await prisma.user.create({
        data: {
          email: email.toLowerCase(),
          passwordHash,
          username,
          displayName: name || null,
          emailVerified: true, // Google accounts are pre-verified
        },
      });
    } else if (!user.emailVerified) {
      // If user exists but email not verified, verify it now
      user = await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    }

    // Generate JWT token
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error("JWT_SECRET missing");
      return res.status(500).json({ error: "Server misconfigured" });
    }

    const token = jwt.sign({ userId: user.id }, secret, {
      expiresIn: "30d",
    });

    return res.json({
      token,
      user: buildUserPayload(user),
    });
  } catch (err) {
    console.error("POST /auth/google error:", err);
    return res.status(500).json({ error: "Failed to authenticate with Google" });
  }
});

export default router;
