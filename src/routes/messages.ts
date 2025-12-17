// src/routes/messages.ts
import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";

const router = Router();

// Helper function to get or create conversation between two users
async function getOrCreateConversation(user1Id: number, user2Id: number) {
  // Ensure consistent ordering (smaller ID first)
  const [smallerId, largerId] = user1Id < user2Id ? [user1Id, user2Id] : [user2Id, user1Id];

  let conversation = await prisma.conversation.findUnique({
    where: {
      user1Id_user2Id: {
        user1Id: smallerId,
        user2Id: largerId,
      },
    },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        user1Id: smallerId,
        user2Id: largerId,
      },
    });
  }

  return conversation;
}

// ----------------------------------------------------
//  GET ALL CONVERSATIONS
// ----------------------------------------------------

// GET /messages/conversations
router.get("/conversations", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    console.log("📬 GET /messages/conversations for user:", currentUserId);

    // Get all conversations where user is either user1 or user2
    const conversations = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: currentUserId },
          { user2Id: currentUserId },
        ],
      },
      include: {
        user1: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        user2: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
          },
        },
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1, // Get last message
        },
      },
      orderBy: {
        lastMessageAt: "desc",
      },
    });

    // Format conversations with the other user's info
    const formattedConversations = await Promise.all(
      conversations.map(async (conv) => {
        const otherUser = conv.user1Id === currentUserId ? conv.user2 : conv.user1;
        const lastMessage = conv.messages[0];

        // Count unread messages
        const unreadCount = await prisma.message.count({
          where: {
            conversationId: conv.id,
            receiverId: currentUserId,
            isRead: false,
          },
        });

        return {
          id: String(conv.id),
          otherUser: {
            id: String(otherUser.id),
            username: otherUser.username,
            displayName: otherUser.displayName,
            avatarUrl: otherUser.avatarUrl,
          },
          lastMessage: lastMessage
            ? {
                text: lastMessage.text,
                mediaUrl: lastMessage.mediaUrl,
                mediaType: lastMessage.mediaType,
                createdAt: lastMessage.createdAt.toISOString(),
                isFromMe: lastMessage.senderId === currentUserId,
              }
            : null,
          unreadCount,
          lastMessageAt: conv.lastMessageAt.toISOString(),
        };
      })
    );

    res.json({ conversations: formattedConversations });
  } catch (err) {
    console.error("GET /messages/conversations error:", err);
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

// ----------------------------------------------------
//  GET MESSAGES IN A CONVERSATION
// ----------------------------------------------------

// GET /messages/:userId
router.get("/:userId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const otherUserId = Number(req.params.userId);
    if (Number.isNaN(otherUserId)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    console.log(`💬 GET /messages/${otherUserId} for user:`, currentUserId);

    // Get or create conversation
    const conversation = await getOrCreateConversation(currentUserId, otherUserId);

    // Get all messages in this conversation
    const messages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    // Mark messages as read
    await prisma.message.updateMany({
      where: {
        conversationId: conversation.id,
        receiverId: currentUserId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    // Get other user info
    const otherUser = await prisma.user.findUnique({
      where: { id: otherUserId },
      select: {
        id: true,
        username: true,
        displayName: true,
        avatarUrl: true,
      },
    });

    if (!otherUser) {
      return res.status(404).json({ error: "User not found" });
    }

    const formattedMessages = messages.map((msg) => ({
      id: String(msg.id),
      text: msg.text,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
      fileName: msg.fileName,
      isFromMe: msg.senderId === currentUserId,
      isRead: msg.isRead,
      createdAt: msg.createdAt.toISOString(),
    }));

    res.json({
      conversationId: String(conversation.id),
      otherUser: {
        id: String(otherUser.id),
        username: otherUser.username,
        displayName: otherUser.displayName,
        avatarUrl: otherUser.avatarUrl,
      },
      messages: formattedMessages,
    });
  } catch (err) {
    console.error("GET /messages/:userId error:", err);
    res.status(500).json({ error: "Failed to load messages" });
  }
});

// ----------------------------------------------------
//  SEND A MESSAGE
// ----------------------------------------------------

// POST /messages/:userId
router.post("/:userId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const receiverId = Number(req.params.userId);
    if (Number.isNaN(receiverId)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const { text, mediaUrl, mediaType, fileName } = req.body;

    if (!text && !mediaUrl) {
      return res.status(400).json({ error: "Message must have text or media" });
    }

    console.log(`📤 POST /messages/${receiverId} from user:`, currentUserId);

    // Check if users are mutually following (optional - remove if you want open messaging)
    const [isFollowing, isFollowingBack] = await Promise.all([
      prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: currentUserId,
            followingId: receiverId,
          },
        },
      }),
      prisma.follow.findUnique({
        where: {
          followerId_followingId: {
            followerId: receiverId,
            followingId: currentUserId,
          },
        },
      }),
    ]);

    if (!isFollowing || !isFollowingBack) {
      return res.status(403).json({ 
        error: "You can only message users you both follow each other" 
      });
    }

    // Get or create conversation
    const conversation = await getOrCreateConversation(currentUserId, receiverId);

    // Create message
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        senderId: currentUserId,
        receiverId,
        text: text || null,
        mediaUrl: mediaUrl || null,
        mediaType: mediaType || null,
        fileName: fileName || null,
      },
    });

    // Update conversation's last message info
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        lastMessageText: text || (mediaType === "image" ? "📷 Image" : "📎 File"),
      },
    });

    res.json({
      message: {
        id: String(message.id),
        text: message.text,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        fileName: message.fileName,
        isFromMe: true,
        isRead: false,
        createdAt: message.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("POST /messages/:userId error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// ----------------------------------------------------
//  MARK MESSAGES AS READ
// ----------------------------------------------------

// POST /messages/:userId/read
router.post("/:userId/read", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const otherUserId = Number(req.params.userId);
    if (Number.isNaN(otherUserId)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const conversation = await getOrCreateConversation(currentUserId, otherUserId);

    await prisma.message.updateMany({
      where: {
        conversationId: conversation.id,
        receiverId: currentUserId,
        isRead: false,
      },
      data: {
        isRead: true,
        readAt: new Date(),
      },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /messages/:userId/read error:", err);
    res.status(500).json({ error: "Failed to mark messages as read" });
  }
});

export default router;
