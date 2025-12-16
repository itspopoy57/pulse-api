// src/routes/comments.ts
import { Router } from "express";
import type { Request } from "express";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { ReactionType } from "@prisma/client";

const router = Router();

const COMMENT_REPORT_HIDE_THRESHOLD = 5;

// --- helpers copied from posts.ts style ---

const POST_INCLUDE = {
  author: true,
  comments: {
    where: { isHidden: false },
    include: {
      author: true,
      replies: {
        where: { isHidden: false },
        include: {
          author: true,
          replies: {
            where: { isHidden: false },
            include: { author: true, replies: true },
          },
        },
      },
    },
  },
  reactions: true,
  vsVotes: true,
};

function buildCommentTree(comments: any[]) {
  const byId: Record<number, any> = {};
  const roots: any[] = [];

  comments.forEach((c) => {
    c.replies = [];
    byId[c.id] = c;
  });

  comments.forEach((c) => {
    if (c.parentId && byId[c.parentId]) {
      byId[c.parentId].replies.push(c);
    } else if (!c.parentId) {
      roots.push(c);
    }
  });

  return roots;
}

function mapComment(c: any): any {
  return {
    id: String(c.id),
    authorName: c.isAnonymous
      ? "Anonymous"
      : c.author?.username || c.author?.email || "User",
    text: c.text,
    createdAt: c.createdAt.toISOString(),
    likeCount: c.likeCount ?? 0,
    mediaUrl: c.mediaUrl ?? undefined,
    mediaType: c.mediaType ?? undefined,
    replies: (c.replies || []).map(mapComment),
  };
}

function mapPost(post: any) {
  const tree = buildCommentTree(post.comments || []);

  return {
    id: String(post.id),
    type: post.type,
    title: post.title,
    body: post.body ?? undefined,
    sideA: post.sideA ?? undefined,
    sideB: post.sideB ?? undefined,
    votesA: post.votesA,
    votesB: post.votesB,
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    isAnonymous: post.isAnonymous,
    region: post.region ?? undefined,
    authorId: String(post.authorId),
    authorName: post.isAnonymous
      ? "Anonymous"
      : post.author?.username || post.author?.email || "User",
    mediaUrl: post.mediaUrl ?? undefined,
    mediaType: post.mediaType ?? undefined,
    comments: tree.map(mapComment),
    createdAt: post.createdAt.toISOString(),
  };
}

// --- ROUTES ---

// POST /comments/:id/report   body: { postId }
router.post("/:id/report", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const commentIdStr = req.params.id;
    const commentId = Number(commentIdStr);
    const postIdStr = (req.body?.postId ?? "").toString();
    const postId = Number(postIdStr);

    if (Number.isNaN(commentId) || Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid ids" });
    }

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!existing || existing.postId !== postId) {
      return res.status(404).json({ error: "Comment not found" });
    }

    // increment report count + mark as reported
    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: {
        isReported: true,
        reportedCount: { increment: 1 },
      },
    });

    // auto-hide when threshold reached
    if (!updated.isHidden && updated.reportedCount >= COMMENT_REPORT_HIDE_THRESHOLD) {
      await prisma.comment.update({
        where: { id: commentId },
        data: { isHidden: true },
      });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: POST_INCLUDE,
    });

    if (!post || post.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    return res.json({ post: mapPost(post) });
  } catch (err) {
    console.error("POST /comments/:id/report error:", err);
    return res.status(500).json({ error: "Failed to report comment" });
  }
});

// POST /comments/:id/react   body: { postId }
// toggles a "like" on the comment and returns updated post
router.post("/:id/react", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const commentIdStr = req.params.id;
    const commentId = Number(commentIdStr);
    const postIdStr = (req.body?.postId ?? "").toString();
    const postId = Number(postIdStr);

    if (Number.isNaN(commentId) || Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid ids" });
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
    });

    if (!comment || comment.postId !== postId || comment.isHidden) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const existing = await prisma.commentReaction.findUnique({
      where: {
        userId_commentId: {
          userId,
          commentId,
        },
      },
    });

    if (!existing) {
      // add like
      await prisma.commentReaction.create({
        data: {
          userId,
          commentId,
          type: ReactionType.UPVOTE,
        },
      });

      await prisma.comment.update({
        where: { id: commentId },
        data: {
          likeCount: { increment: 1 },
        },
      });
    } else {
      // remove like
      await prisma.commentReaction.delete({
        where: { id: existing.id },
      });

      await prisma.comment.update({
        where: { id: commentId },
        data: {
          likeCount: {
            decrement: 1,
          },
        },
      });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      include: POST_INCLUDE,
    });

    if (!post || post.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    return res.json({ post: mapPost(post) });
  } catch (err) {
    console.error("POST /comments/:id/react error:", err);
    return res.status(500).json({ error: "Failed to react to comment" });
  }
});

export default router;
