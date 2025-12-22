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
        sentConnections: true,
        receivedConnections: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Count accepted connections
    const connectionCount = await prisma.connection.count({
      where: {
        OR: [
          { requesterId: currentUserId, status: "ACCEPTED" },
          { receiverId: currentUserId, status: "ACCEPTED" },
        ],
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
        connectionCount,
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
    });

    // Count accepted connections
    const connectionCount = await prisma.connection.count({
      where: {
        OR: [
          { requesterId: currentUserId, status: "ACCEPTED" },
          { receiverId: currentUserId, status: "ACCEPTED" },
        ],
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
        connectionCount,
        isMe: true,
      },
    });
  } catch (err) {
    console.error("PATCH /users/me error:", err);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

// ----------------------------------------------------
//  GET CONNECTIONS (ACCEPTED CONNECTIONS)
// ----------------------------------------------------

// GET /users/connections
router.get("/connections", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("🤝 GET /users/connections for user:", currentUserId);

    // Get all accepted connections
    const connections = await prisma.connection.findMany({
      where: {
        OR: [
          { requesterId: currentUserId, status: "ACCEPTED" },
          { receiverId: currentUserId, status: "ACCEPTED" },
        ],
      },
      include: {
        requester: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            bio: true,
          },
        },
        receiver: {
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

    const usersWithConnectionInfo = await Promise.all(
      connections.map(async (connection) => {
        // Get the other user in the connection
        const otherUser =
          connection.requesterId === currentUserId
            ? connection.receiver
            : connection.requester;

        const connectionCount = await prisma.connection.count({
          where: {
            OR: [
              { requesterId: otherUser.id, status: "ACCEPTED" },
              { receiverId: otherUser.id, status: "ACCEPTED" },
            ],
          },
        });

        return {
          id: String(otherUser.id),
          username: otherUser.username,
          displayName: otherUser.displayName,
          avatarUrl: otherUser.avatarUrl,
          bio: otherUser.bio,
          connectionCount,
          isConnected: true,
          connectionStatus: "ACCEPTED",
        };
      })
    );

    return res.json({ users: usersWithConnectionInfo });
  } catch (err) {
    console.error("GET /users/connections error:", err);
    res.status(500).json({ error: "Failed to load connections" });
  }
});

// ----------------------------------------------------
//  GET PENDING CONNECTION REQUESTS
// ----------------------------------------------------

// GET /users/connection-requests
router.get("/connection-requests", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("📬 GET /users/connection-requests for user:", currentUserId);

    // Get pending requests received by current user
    const requests = await prisma.connection.findMany({
      where: {
        receiverId: currentUserId,
        status: "PENDING",
      },
      include: {
        requester: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            bio: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const usersWithConnectionInfo = await Promise.all(
      requests.map(async (request) => {
        const connectionCount = await prisma.connection.count({
          where: {
            OR: [
              { requesterId: request.requester.id, status: "ACCEPTED" },
              { receiverId: request.requester.id, status: "ACCEPTED" },
            ],
          },
        });

        return {
          id: String(request.requester.id),
          username: request.requester.username,
          displayName: request.requester.displayName,
          avatarUrl: request.requester.avatarUrl,
          bio: request.requester.bio,
          connectionCount,
          connectionStatus: "PENDING",
          requestId: String(request.id),
          requestedAt: request.createdAt.toISOString(),
        };
      })
    );

    return res.json({ users: usersWithConnectionInfo });
  } catch (err) {
    console.error("GET /users/connection-requests error:", err);
    res.status(500).json({ error: "Failed to load connection requests" });
  }
});

// ----------------------------------------------------
//  GET FOLLOWING USERS
// ----------------------------------------------------

// GET /users/following - Get users that current user is following
router.get("/following", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("✓ GET /users/following for user:", currentUserId);

    // Get all users the current user is following
    const follows = await prisma.follow.findMany({
      where: { followerId: currentUserId },
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
      orderBy: { createdAt: "desc" },
    });

    const usersWithConnectionInfo = await Promise.all(
      follows.map(async (follow) => {
        const user = follow.following;
        
        // Check if they follow back (mutual)
        const followsBack = await prisma.follow.findFirst({
          where: {
            followerId: user.id,
            followingId: currentUserId,
          },
        });

        // Count their followers
        const followerCount = await prisma.follow.count({
          where: { followingId: user.id },
        });

        // Count who they're following
        const followingCount = await prisma.follow.count({
          where: { followerId: user.id },
        });

        return {
          id: String(user.id),
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          bio: user.bio,
          followerCount,
          followingCount,
          isFollowing: true,
          isFollowingBack: !!followsBack,
          isMutual: !!followsBack,
        };
      })
    );

    return res.json({ users: usersWithConnectionInfo });
  } catch (err) {
    console.error("GET /users/following error:", err);
    res.status(500).json({ error: "Failed to load following" });
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

    // Get connection status for each user
    const usersWithConnectionInfo = await Promise.all(
      users.map(async (user) => {
        const [connectionCount, existingConnection] = await Promise.all([
          prisma.connection.count({
            where: {
              OR: [
                { requesterId: user.id, status: "ACCEPTED" },
                { receiverId: user.id, status: "ACCEPTED" },
              ],
            },
          }),
          prisma.connection.findFirst({
            where: {
              OR: [
                { requesterId: currentUserId, receiverId: user.id },
                { requesterId: user.id, receiverId: currentUserId },
              ],
            },
          }),
        ]);

        let connectionStatus = "NONE";
        let isPending = false;
        let isConnected = false;
        let sentByMe = false;

        if (existingConnection) {
          connectionStatus = existingConnection.status;
          isPending = existingConnection.status === "PENDING";
          isConnected = existingConnection.status === "ACCEPTED";
          sentByMe = existingConnection.requesterId === currentUserId;
        }

        return {
          id: String(user.id),
          username: user.username,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          bio: user.bio,
          connectionCount,
          connectionStatus,
          isConnected,
          isPending,
          sentByMe,
        };
      })
    );

    return res.json({ users: usersWithConnectionInfo });
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

    // Get connection count and status
    const [connectionCount, existingConnection] = await Promise.all([
      prisma.connection.count({
        where: {
          OR: [
            { requesterId: user.id, status: "ACCEPTED" },
            { receiverId: user.id, status: "ACCEPTED" },
          ],
        },
      }),
      prisma.connection.findFirst({
        where: {
          OR: [
            { requesterId: currentUserId, receiverId: user.id },
            { requesterId: user.id, receiverId: currentUserId },
          ],
        },
      }),
    ]);

    let connectionStatus = "NONE";
    let isPending = false;
    let isConnected = false;
    let sentByMe = false;

    if (existingConnection) {
      connectionStatus = existingConnection.status;
      isPending = existingConnection.status === "PENDING";
      isConnected = existingConnection.status === "ACCEPTED";
      sentByMe = existingConnection.requesterId === currentUserId;
    }

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
        connectionCount,
        isMe: currentUserId === user.id,
        connectionStatus,
        isConnected,
        isPending,
        sentByMe,
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
//  CONNECTION MANAGEMENT
// ----------------------------------------------------

// POST /users/:id/connect - Send connection request
router.post("/:id/connect", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const targetUserId = Number(idStr);

    console.log(
      "POST /users/:id/connect -> currentUser:",
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
      return res.status(400).json({ error: "Cannot connect with yourself" });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
    });

    if (!targetUser) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if connection already exists
    const existing = await prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: currentUserId, receiverId: targetUserId },
          { requesterId: targetUserId, receiverId: currentUserId },
        ],
      },
    });

    if (existing) {
      return res.status(400).json({ 
        error: "Connection request already exists",
        status: existing.status 
      });
    }

    // Create connection request
    const connection = await prisma.connection.create({
      data: {
        requesterId: currentUserId,
        receiverId: targetUserId,
        status: "PENDING",
      },
    });

    // Send notification to the target user
    const requester = await prisma.user.findUnique({
      where: { id: currentUserId },
    });
    
    if (requester) {
      const requesterName = requester.displayName || requester.username || 'Someone';
      
      // Create in-app notification
      await prisma.notification.create({
        data: {
          userId: targetUserId,
          type: 'connection_request',
          title: 'New Connection Request',
          body: `${requesterName} wants to connect with you`,
          fromUserId: currentUserId,
        },
      });
      
      // Send push notification if enabled
      if (targetUser.notifyConnections && targetUser.pushToken) {
        await notifyNewFollower(targetUserId, currentUserId, requesterName);
      }
    }

    return res.json({
      ok: true,
      connectionStatus: "PENDING",
      isPending: true,
      sentByMe: true,
    });
  } catch (err) {
    console.error("POST /users/:id/connect error:", err);
    res.status(500).json({ error: "Failed to send connection request" });
  }
});

// POST /users/:id/accept-connection - Accept connection request
router.post("/:id/accept-connection", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const requesterId = Number(idStr);

    if (Number.isNaN(requesterId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // Find the pending connection request
    const connection = await prisma.connection.findFirst({
      where: {
        requesterId: requesterId,
        receiverId: currentUserId,
        status: "PENDING",
      },
    });

    if (!connection) {
      return res.status(404).json({ error: "Connection request not found" });
    }

    // Update connection status to ACCEPTED
    await prisma.connection.update({
      where: { id: connection.id },
      data: {
        status: "ACCEPTED",
        acceptedAt: new Date(),
      },
    });

    // Send notification to requester
    const receiver = await prisma.user.findUnique({
      where: { id: currentUserId },
    });
    
    if (receiver) {
      const receiverName = receiver.displayName || receiver.username || 'Someone';
      
      await prisma.notification.create({
        data: {
          userId: requesterId,
          type: 'connection_accepted',
          title: 'Connection Accepted',
          body: `${receiverName} accepted your connection request`,
          fromUserId: currentUserId,
        },
      });
    }

    return res.json({
      ok: true,
      connectionStatus: "ACCEPTED",
      isConnected: true,
    });
  } catch (err) {
    console.error("POST /users/:id/accept-connection error:", err);
    res.status(500).json({ error: "Failed to accept connection" });
  }
});

// POST /users/:id/reject-connection - Reject connection request
router.post("/:id/reject-connection", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const requesterId = Number(idStr);

    if (Number.isNaN(requesterId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // Find the pending connection request
    const connection = await prisma.connection.findFirst({
      where: {
        requesterId: requesterId,
        receiverId: currentUserId,
        status: "PENDING",
      },
    });

    if (!connection) {
      return res.status(404).json({ error: "Connection request not found" });
    }

    // Delete the connection request
    await prisma.connection.delete({
      where: { id: connection.id },
    });

    return res.json({
      ok: true,
      connectionStatus: "NONE",
    });
  } catch (err) {
    console.error("POST /users/:id/reject-connection error:", err);
    res.status(500).json({ error: "Failed to reject connection" });
  }
});

// DELETE /users/:id/disconnect - Remove connection
router.delete("/:id/disconnect", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const otherUserId = Number(idStr);

    if (Number.isNaN(otherUserId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // Find the connection
    const connection = await prisma.connection.findFirst({
      where: {
        OR: [
          { requesterId: currentUserId, receiverId: otherUserId },
          { requesterId: otherUserId, receiverId: currentUserId },
        ],
      },
    });

    if (!connection) {
      return res.status(404).json({ error: "Connection not found" });
    }

    // Delete the connection
    await prisma.connection.delete({
      where: { id: connection.id },
    });

    return res.json({
      ok: true,
      connectionStatus: "NONE",
    });
  } catch (err) {
    console.error("DELETE /users/:id/disconnect error:", err);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});

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

    const { messages, connections, comments, reactions, mentions } = req.body;

    await prisma.user.update({
      where: { id: currentUserId },
      data: {
        notifyMessages: messages ?? true,
        notifyConnections: connections ?? true,
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

// ----------------------------------------------------
//  BLOCK USERS
// ----------------------------------------------------

// POST /users/:id/block - Block a user
router.post("/:id/block", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const targetUserId = Number(req.params.id);
    if (Number.isNaN(targetUserId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    if (targetUserId === currentUserId) {
      return res.status(400).json({ error: "Cannot block yourself" });
    }

    // Check if already blocked
    const existing = await prisma.blockedUser.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId: currentUserId,
          blockedId: targetUserId,
        },
      },
    });

    if (existing) {
      return res.status(400).json({ error: "User already blocked" });
    }

    // Create block
    await prisma.blockedUser.create({
      data: {
        blockerId: currentUserId,
        blockedId: targetUserId,
      },
    });

    // Remove any existing connection
    await prisma.connection.deleteMany({
      where: {
        OR: [
          { requesterId: currentUserId, receiverId: targetUserId },
          { requesterId: targetUserId, receiverId: currentUserId },
        ],
      },
    });

    return res.json({ ok: true, isBlocked: true });
  } catch (err) {
    console.error("POST /users/:id/block error:", err);
    res.status(500).json({ error: "Failed to block user" });
  }
});

// DELETE /users/:id/unblock - Unblock a user
router.delete("/:id/unblock", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const targetUserId = Number(req.params.id);
    if (Number.isNaN(targetUserId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    // Find and delete block
    const block = await prisma.blockedUser.findUnique({
      where: {
        blockerId_blockedId: {
          blockerId: currentUserId,
          blockedId: targetUserId,
        },
      },
    });

    if (!block) {
      return res.status(404).json({ error: "User not blocked" });
    }

    await prisma.blockedUser.delete({
      where: { id: block.id },
    });

    return res.json({ ok: true, isBlocked: false });
  } catch (err) {
    console.error("DELETE /users/:id/unblock error:", err);
    res.status(500).json({ error: "Failed to unblock user" });
  }
});

// GET /users/blocked - Get list of blocked users
router.get("/blocked", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const blocks = await prisma.blockedUser.findMany({
      where: { blockerId: currentUserId },
      include: {
        blocked: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            bio: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const users = blocks.map(block => ({
      id: String(block.blocked.id),
      username: block.blocked.username,
      displayName: block.blocked.displayName,
      avatarUrl: block.blocked.avatarUrl,
      bio: block.blocked.bio,
      blockedAt: block.createdAt.toISOString(),
    }));

    return res.json({ users });
  } catch (err) {
    console.error("GET /users/blocked error:", err);
    res.status(500).json({ error: "Failed to load blocked users" });
  }
});

export default router;
