// src/routes/messages.ts
import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { requireAdmin } from "../middleware/admin";
import { notifyNewMessage } from "../utils/pushNotifications";

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

    // Get all messages in this conversation (exclude deleted for regular users)
    const messages = await prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        isDeleted: false, // Only show non-deleted messages
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

    // Send push notification to receiver
    const sender = await prisma.user.findUnique({
      where: { id: currentUserId },
      select: { displayName: true, username: true },
    });
    
    if (sender) {
      const senderName = sender.displayName || sender.username || 'Someone';
      const messagePreview = text || (mediaType === "image" ? "📷 Sent an image" : "📎 Sent a file");
      await notifyNewMessage(
        receiverId,
        currentUserId,
        senderName,
        messagePreview.substring(0, 100),
        conversation.id
      );
    }

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

// ----------------------------------------------------
//  EDIT A MESSAGE
// ----------------------------------------------------

// PATCH /messages/:messageId
router.patch("/:messageId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const messageId = Number(req.params.messageId);
    if (Number.isNaN(messageId)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Message text is required" });
    }

    console.log(`✏️ PATCH /messages/${messageId} by user:`, currentUserId);

    // Find the message
    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Only allow sender to edit their own messages
    if (message.senderId !== currentUserId) {
      return res.status(403).json({ error: "You can only edit your own messages" });
    }

    // Check if message is recent (within 5 minutes)
    const messageAge = Date.now() - message.createdAt.getTime();
    const fiveMinutes = 5 * 60 * 1000;
    if (messageAge > fiveMinutes) {
      return res.status(403).json({ error: "You can only edit messages within 5 minutes of sending" });
    }

    // Update the message
    const updatedMessage = await prisma.message.update({
      where: { id: messageId },
      data: {
        text: text.trim(),
      },
    });

    // Update conversation's last message text if this was the last message
    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      include: {
        messages: {
          where: { isDeleted: false },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (conversation && conversation.messages[0]?.id === messageId) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageText: text.trim(),
        },
      });
    }

    res.json({
      message: {
        id: String(updatedMessage.id),
        text: updatedMessage.text,
        mediaUrl: updatedMessage.mediaUrl,
        mediaType: updatedMessage.mediaType,
        fileName: updatedMessage.fileName,
        isFromMe: true,
        isRead: updatedMessage.isRead,
        createdAt: updatedMessage.createdAt.toISOString(),
      },
    });
  } catch (err) {
    console.error("PATCH /messages/:messageId error:", err);
    res.status(500).json({ error: "Failed to edit message" });
  }
});

// ----------------------------------------------------
//  DELETE A MESSAGE
// ----------------------------------------------------

// DELETE /messages/:messageId
router.delete("/:messageId", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.userId;
    if (!currentUserId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const messageId = Number(req.params.messageId);
    if (Number.isNaN(messageId)) {
      return res.status(400).json({ error: "Invalid message ID" });
    }

    console.log(`🗑️ DELETE /messages/${messageId} by user:`, currentUserId);

    // Find the message
    const message = await prisma.message.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    // Only allow sender to delete their own messages
    if (message.senderId !== currentUserId) {
      return res.status(403).json({ error: "You can only delete your own messages" });
    }

    // Soft delete the message (keep for admin monitoring)
    await prisma.message.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: currentUserId,
      },
    });

    // Update conversation's last message if needed (only non-deleted messages)
    const conversation = await prisma.conversation.findUnique({
      where: { id: message.conversationId },
      include: {
        messages: {
          where: { isDeleted: false },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (conversation) {
      const lastMessage = conversation.messages[0];
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: lastMessage?.createdAt || conversation.lastMessageAt,
          lastMessageText: lastMessage?.text || (lastMessage?.mediaType === "image" ? "📷 Image" : "📎 File") || null,
        },
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /messages/:messageId error:", err);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

// ----------------------------------------------------
//  ADMIN: GET ALL CONVERSATIONS (FOR MONITORING)
// ----------------------------------------------------

// GET /messages/admin/all-conversations
router.get("/admin/all-conversations", authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
  try {
    console.log("🔍 ADMIN: GET /messages/admin/all-conversations");

    const conversations = await prisma.conversation.findMany({
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
          take: 1,
        },
      },
      orderBy: {
        lastMessageAt: "desc",
      },
    });

    const formattedConversations = conversations.map((conv) => ({
      id: String(conv.id),
      user1: {
        id: String(conv.user1.id),
        username: conv.user1.username,
        displayName: conv.user1.displayName,
        avatarUrl: conv.user1.avatarUrl,
      },
      user2: {
        id: String(conv.user2.id),
        username: conv.user2.username,
        displayName: conv.user2.displayName,
        avatarUrl: conv.user2.avatarUrl,
      },
      lastMessage: conv.messages[0]
        ? {
            text: conv.messages[0].text,
            mediaUrl: conv.messages[0].mediaUrl,
            mediaType: conv.messages[0].mediaType,
            createdAt: conv.messages[0].createdAt.toISOString(),
            isDeleted: conv.messages[0].isDeleted,
          }
        : null,
      lastMessageAt: conv.lastMessageAt.toISOString(),
    }));

    res.json({ conversations: formattedConversations });
  } catch (err) {
    console.error("GET /messages/admin/all-conversations error:", err);
    res.status(500).json({ error: "Failed to load conversations" });
  }
});

// ----------------------------------------------------
//  ADMIN: GET CONVERSATION MESSAGES (INCLUDING DELETED)
// ----------------------------------------------------

// GET /messages/admin/conversation/:conversationId
router.get("/admin/conversation/:conversationId", authMiddleware, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const conversationId = Number(req.params.conversationId);
    if (Number.isNaN(conversationId)) {
      return res.status(400).json({ error: "Invalid conversation ID" });
    }

    console.log(`🔍 ADMIN: GET /messages/admin/conversation/${conversationId}`);

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
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
          orderBy: { createdAt: "asc" },
          // Include ALL messages, even deleted ones
        },
      },
    });

    if (!conversation) {
      return res.status(404).json({ error: "Conversation not found" });
    }

    const formattedMessages = conversation.messages.map((msg) => ({
      id: String(msg.id),
      text: msg.text,
      mediaUrl: msg.mediaUrl,
      mediaType: msg.mediaType,
      fileName: msg.fileName,
      senderId: String(msg.senderId),
      receiverId: String(msg.receiverId),
      isRead: msg.isRead,
      isDeleted: msg.isDeleted,
      deletedAt: msg.deletedAt?.toISOString(),
      deletedBy: msg.deletedBy ? String(msg.deletedBy) : null,
      createdAt: msg.createdAt.toISOString(),
    }));

    res.json({
      conversation: {
        id: String(conversation.id),
        user1: {
          id: String(conversation.user1.id),
          username: conversation.user1.username,
          displayName: conversation.user1.displayName,
          avatarUrl: conversation.user1.avatarUrl,
        },
        user2: {
          id: String(conversation.user2.id),
          username: conversation.user2.username,
          displayName: conversation.user2.displayName,
          avatarUrl: conversation.user2.avatarUrl,
        },
        messages: formattedMessages,
      },
    });
  } catch (err) {
    console.error("DELETE /messages/:messageId error:", err);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

export default router;
