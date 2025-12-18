// src/routes/users.ts
import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { notifyNewFollower } from "../utils/pushNotifications";

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
//  GET CONNECTIONS (MUTUAL FOLLOWS)
// ----------------------------------------------------

// GET /users/connections
router.get("/connections", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("🤝 GET /users/connections for user:", currentUserId);

    // Get all users where both follow each other
    const mutualFollows = await prisma.follow.findMany({
      where: {
        followerId: currentUserId,
      },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            bio: true,
          },
        },
      },
    });

    // Filter to only mutual connections
    const connections = await Promise.all(
      mutualFollows.map(async (follow) => {
        const isFollowingBack = await prisma.follow.findUnique({
          where: {
            followerId_followingId: {
              followerId: follow.followingId,
              followingId: currentUserId,
            },
          },
        });

        if (!isFollowingBack) return null;

        const [followerCount, followingCount] = await Promise.all([
          prisma.follow.count({ where: { followingId: follow.followingId } }),
          prisma.follow.count({ where: { followerId: follow.followingId } }),
        ]);

        return {
          id: String(follow.following.id),
          username: follow.following.username,
          displayName: follow.following.displayName,
          avatarUrl: follow.following.avatarUrl,
          bio: follow.following.bio,
          followerCount,
          followingCount,
          isFollowing: true,
          isFollowingBack: true,
          isMutual: true,
        };
      })
    );

    const filteredConnections = connections.filter((c) => c !== null);

    return res.json({ users: filteredConnections });
  } catch (err) {
    console.error("GET /users/connections error:", err);
    res.status(500).json({ error: "Failed to load connections" });
  }
});

// ----------------------------------------------------
//  GET FOLLOWING LIST
// ----------------------------------------------------

// GET /users/following
router.get("/following", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("✓ GET /users/following for user:", currentUserId);

    const following = await prisma.follow.findMany({
      where: {
        followerId: currentUserId,
      },
      include: {
        following: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            bio: true,
          },
        },
      },
    });

    const usersWithFollowInfo = await Promise.all(
      following.map(async (follow) => {
        const [followerCount, followingCount, isFollowingBack] = await Promise.all([
          prisma.follow.count({ where: { followingId: follow.followingId } }),
          prisma.follow.count({ where: { followerId: follow.followingId } }),
          prisma.follow.findUnique({
            where: {
              followerId_followingId: {
                followerId: follow.followingId,
                followingId: currentUserId,
              },
            },
          }),
        ]);

        return {
          id: String(follow.following.id),
          username: follow.following.username,
          displayName: follow.following.displayName,
          avatarUrl: follow.following.avatarUrl,
          bio: follow.following.bio,
          followerCount,
          followingCount,
          isFollowing: true,
          isFollowingBack: !!isFollowingBack,
          isMutual: !!isFollowingBack,
        };
      })
    );

    return res.json({ users: usersWithFollowInfo });
  } catch (err) {
    console.error("GET /users/following error:", err);
    res.status(500).json({ error: "Failed to load following list" });
  }
});

// ----------------------------------------------------
//  SEARCH USERS  (/users/search)
// ----------------------------------------------------

// GET /users/search?q=query
router.get("/search", authMiddleware, async (req: AuthRequest, res) => {
  try {
    console.log("🔍 GET /users/search called with query:", req.query);
    
    const currentUserId = req.userId;
    if (!currentUserId) {
      console.log("❌ Search failed: No userId in request");
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("✅ Authenticated user:", currentUserId);

    const query = req.query.q as string;
    if (!query || query.trim().length === 0) {
      console.log("⚠️ Empty search query, returning empty results");
      return res.json({ users: [] });
    }

    console.log("🔎 Searching for:", query);

    const searchTerm = query.trim().toLowerCase();

    // Search for users by username or display name
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { username: { contains: searchTerm, mode: "insensitive" } },
          { displayName: { contains: searchTerm, mode: "insensitive" } },
        ],
        NOT: {
          id: currentUserId, // Exclude current user from results
        },
      },
      take: 50, // Limit results
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get follow relationships for each user
    const usersWithFollowInfo = await Promise.all(
      users.map(async (user) => {
        const [followerCount, followingCount, isFollowing, isFollowingBack] =
          await Promise.all([
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
            prisma.follow.findUnique({
              where: {
                followerId_followingId: {
                  followerId: user.id,
                  followingId: currentUserId,
                },
              },
            }),
          ]);

        return {
          id: String(user.id),
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          bio: user.bio,
          followerCount,
          followingCount,
          isFollowing: !!isFollowing,
          isFollowingBack: !!isFollowingBack,
          isMutual: !!isFollowing && !!isFollowingBack,
        };
      })
    );

    return res.json({ users: usersWithFollowInfo });
  } catch (err) {
    console.error("GET /users/search error:", err);
    res.status(500).json({ error: "Failed to search users" });
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
        
        // Send notification to the followed user
        const follower = await prisma.user.findUnique({
          where: { id: currentUserId },
        });
        if (follower) {
          const followerName = follower.displayName || follower.username || 'Someone';
          await notifyNewFollower(targetUserId, currentUserId, followerName);
        }
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

// ----------------------------------------------------
//  PUSH NOTIFICATIONS
// ----------------------------------------------------

// POST /users/device-token
router.post("/device-token", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { token, platform } = req.body;

    if (!token || !platform) {
      return res.status(400).json({ error: "Token and platform are required" });
    }

    await prisma.user.update({
      where: { id: currentUserId },
      data: {
        pushToken: token,
        pushPlatform: platform,
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /users/device-token error:", err);
    res.status(500).json({ error: "Failed to save device token" });
  }
});

// PUT /users/notification-preferences
router.put("/notification-preferences", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { messages, follows, comments, reactions, mentions } = req.body;

    await prisma.user.update({
      where: { id: currentUserId },
      data: {
        notifyMessages: messages ?? true,
        notifyFollows: follows ?? true,
        notifyComments: comments ?? true,
        notifyReactions: reactions ?? true,
        notifyMentions: mentions ?? true,
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("PUT /users/notification-preferences error:", err);
    res.status(500).json({ error: "Failed to update preferences" });
  }
});

// GET /users/notifications
router.get("/notifications", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const notifications = await prisma.notification.findMany({
      where: { userId: currentUserId },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return res.json({ notifications });
  } catch (err) {
    console.error("GET /users/notifications error:", err);
    res.status(500).json({ error: "Failed to load notifications" });
  }
});

// POST /users/notifications/:id/read
router.post("/notifications/:id/read", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const notificationId = Number(req.params.id);
    if (Number.isNaN(notificationId)) {
      return res.status(400).json({ error: "Invalid notification id" });
    }

    await prisma.notification.update({
      where: { id: notificationId, userId: currentUserId },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /users/notifications/:id/read error:", err);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// POST /users/notifications/read-all
router.post("/notifications/read-all", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await prisma.notification.updateMany({
      where: { userId: currentUserId, isRead: false },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("POST /users/notifications/read-all error:", err);
    res.status(500).json({ error: "Failed to mark all notifications as read" });
  }
});

// GET /users/notifications/unread-count
router.get("/notifications/unread-count", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const count = await prisma.notification.count({
      where: { userId: currentUserId, isRead: false },
    });

    return res.json({ count });
  } catch (err) {
    console.error("GET /users/notifications/unread-count error:", err);
    res.status(500).json({ error: "Failed to get unread count" });
  }
});

export default router;
