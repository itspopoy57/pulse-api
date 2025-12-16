// src/routes/users.ts
import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";

const router = Router();

// ----- shared helpers copied from posts.ts -----

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
      : c.author?.displayName ||
        c.author?.username ||
        c.author?.email ||
        "User",
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
      : post.author.displayName ||
        post.author.username ||
        post.author.email,
    mediaUrl: post.mediaUrl ?? undefined,
    mediaType: post.mediaType ?? undefined,
    comments: tree.map(mapComment),
    createdAt: post.createdAt.toISOString(),
  };
}

// ----------------------------------------------------
//  CURRENT USER PROFILE  (/users/me)
// ----------------------------------------------------

// GET /users/me
router.get("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findUnique({
      where: { id: currentUserId },
      include: {
        followers: true,
        following: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const { passwordHash, ...rest } = user;

    return res.json({
      user: {
        id: String(user.id),
        email: user.email,
        username: user.username,
        region: user.region,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt.toISOString(),
        followerCount: user.followers.length,
        followingCount: user.following.length,
        // isMe is always true here
        isMe: true,
      },
    });
  } catch (err) {
    console.error("GET /users/me error:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// PATCH /users/me
router.patch("/me", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { displayName, bio, region, avatarUrl } = req.body;

    const user = await prisma.user.update({
      where: { id: currentUserId },
      data: {
        displayName,
        bio,
        region,
        avatarUrl,
      },
      include: {
        followers: true,
        following: true,
      },
    });

    const { passwordHash, ...rest } = user;

    return res.json({
      user: {
        id: String(user.id),
        email: user.email,
        username: user.username,
        region: user.region,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt.toISOString(),
        followerCount: user.followers.length,
        followingCount: user.following.length,
        isMe: true,
      },
    });
  } catch (err) {
    console.error("PATCH /users/me error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ----------------------------------------------------
//  OTHER USER PROFILE  (/users/:id/profile)
// ----------------------------------------------------

// GET /users/:id/profile
router.get("/:id/profile", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const userId = Number(idStr);

    console.log("GET /users/:id/profile -> param:", idStr, "parsed:", userId);

    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      console.log("GET /users/:id/profile – user not found for id", userId);
      return res.status(404).json({ error: "User not found" });
    }

    // follower / following counts + whether current user follows them
    const [followerCount, followingCount, existingFollow] = await Promise.all([
      prisma.follow.count({ where: { followingId: user.id } }),
      prisma.follow.count({ where: { followerId: user.id } }),
      prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: user.id,
          },
        },
      }),
    ]);

    const posts = await prisma.post.findMany({
      where: {
        authorId: user.id,
        isHidden: false,
        isAnonymous: false, // only show non-anonymous posts
      },
      orderBy: { createdAt: "desc" },
      include: POST_INCLUDE,
    });

    const response = {
      user: {
        id: String(user.id),
        username: user.username,
        email: user.email,
        region: user.region,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt.toISOString(),
        followerCount,
        followingCount,
        isMe: currentUserId === user.id,
        isFollowing: !!existingFollow,
      },
      posts: posts.map(mapPost),
    };

    res.json(response);
  } catch (err) {
    console.error("GET /users/:id/profile error:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// ----------------------------------------------------
//  FOLLOW / UNFOLLOW  (/users/:id/follow-toggle)
// ----------------------------------------------------

router.post(
  "/:id/follow-toggle",
  authMiddleware,
  async (req: AuthRequest, res) => {
    try {
      const currentUserId = req.userId;
      if (!currentUserId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const idStr = req.params.id;
      const targetUserId = Number(idStr);

      console.log(
        "POST /users/:id/follow-toggle -> currentUser:",
        currentUserId,
        "target:",
        idStr,
        "parsed:",
        targetUserId
      );

      if (Number.isNaN(targetUserId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      if (targetUserId === currentUserId) {
        return res.status(400).json({ error: "Cannot follow yourself" });
      }

      const targetUser = await prisma.user.findUnique({
        where: { id: targetUserId },
      });

      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const existing = await prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: targetUserId,
          },
        },
      });

      let following: boolean;

      if (!existing) {
        await prisma.follow.create({
          data: {
            followerId: currentUserId,
            followingId: targetUserId,
          },
        });
        following = true;
      } else {
        await prisma.follow.delete({
          where: { id: existing.id },
        });
        following = false;
      }

      const followerCount = await prisma.follow.count({
        where: { followingId: targetUserId },
      });

      return res.json({
        ok: true,
        following,
        followerCount,
      });
    } catch (err) {
      console.error("POST /users/:id/follow-toggle error:", err);
      res.status(500).json({ error: "Failed to toggle follow" });
    }
  }
);

export default router;
