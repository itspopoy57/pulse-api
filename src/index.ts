// src/index.ts
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import {
  commentLimiter,
  genericLimiter,
} from "./middleware/rateLimit";

import authRoutes from "./routes/auth";
import postRoutes from "./routes/posts";
import userRoutes from "./routes/users";
import commentRoutes from "./routes/comments";
import adminRoutes from "./routes/admin";
import uploadRoutes from "./routes/uploads";


dotenv.config();

// Set to true to force PROD database even when running locally
const FORCE_PROD_DB = false;

// Auto-switch to DEV database when running locally
const isDev = process.env.NODE_ENV !== "production";
if (isDev && !FORCE_PROD_DB && process.env.DATABASE_URL_DEV) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_DEV;
  console.log("🔧 Using DEV database");
} else {
  console.log("🚀 Using PROD database");
  if (FORCE_PROD_DB && isDev) {
    console.log("⚠️  FORCE_PROD_DB is enabled - using PROD database in dev mode");
  }
}
console.log("📊 Database:", process.env.DATABASE_URL?.split("@")[1]?.split("/")[0] || "unknown");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));


app.use("/uploads", uploadRoutes);


// Apply generic rate limiter to all routes
app.use(genericLimiter);

// Auth routes have their own stricter limiter (defined in auth.ts)
app.use("/auth", authRoutes);

// Posts and users use the generic limiter (already applied above)
app.use("/posts", postRoutes);
app.use("/users", userRoutes);

// Comments get the comment-specific limiter
app.use("/comments", commentLimiter, commentRoutes);

// Admin routes (protected by admin middleware)
app.use("/admin", adminRoutes);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 Pulse API listening on http://localhost:${PORT}`);
});


