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

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true }));


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


