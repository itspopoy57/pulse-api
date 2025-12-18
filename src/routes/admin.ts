import express from 'express';
import { prisma } from '../prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';

const router = express.Router();

// All admin routes require authentication and admin privileges
router.use(authMiddleware);
router.use(requireAdmin);

/**
 * GET /admin/stats
 * Get moderation statistics
 */
router.get('/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      bannedUsers,
      reportedPosts,
      hiddenPosts,
      reportedComments,
      hiddenComments,
      totalPosts,
      totalComments
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isBanned: true } }),
      prisma.post.count({ where: { isReported: true } }),
      prisma.post.count({ where: { isHidden: true } }),
      prisma.comment.count({ where: { isReported: true } }),
      prisma.comment.count({ where: { isHidden: true } }),
      prisma.post.count(),
      prisma.comment.count()
    ]);

    res.json({
      users: {
        total: totalUsers,
        banned: bannedUsers,
        active: totalUsers - bannedUsers
      },
      posts: {
        total: totalPosts,
        reported: reportedPosts,
        hidden: hiddenPosts
      },
      comments: {
        total: totalComments,
        reported: reportedComments,
        hidden: hiddenComments
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /admin/reported-posts
 * Get all reported posts
 */
router.get('/reported-posts', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [posts, total] = await Promise.all([
      prisma.post.findMany({
        where: { isReported: true },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              email: true
            }
          },
          poll: {
            include: {
              options: true
            }
          }
        },
        orderBy: { reportedCount: 'desc' },
        skip,
        take: limit
      }),
      prisma.post.count({ where: { isReported: true } })
    ]);

    res.json({
      posts,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching reported posts:', error);
    res.status(500).json({ error: 'Failed to fetch reported posts' });
  }
});

/**
 * GET /admin/reported-comments
 * Get all reported comments
 */
router.get('/reported-comments', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [comments, total] = await Promise.all([
      prisma.comment.findMany({
        where: { isReported: true },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              displayName: true,
              email: true
            }
          },
          post: {
            select: {
              id: true,
              title: true,
              type: true
            }
          }
        },
        orderBy: { reportedCount: 'desc' },
        skip,
        take: limit
      }),
      prisma.comment.count({ where: { isReported: true } })
    ]);

    res.json({
      comments,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching reported comments:', error);
    res.status(500).json({ error: 'Failed to fetch reported comments' });
  }
});

/**
 * POST /admin/posts/:id/moderate
 * Moderate a post (approve or hide)
 */
router.post('/posts/:id/moderate', async (req: AuthRequest, res) => {
  try {
    const postId = parseInt(req.params.id);
    const { action, note } = req.body; // action: 'approve' | 'hide' | 'delete'
    const adminId = req.userId;

    if (!['approve', 'hide', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (action === 'delete') {
      await prisma.post.delete({
        where: { id: postId }
      });
      return res.json({ message: 'Post deleted successfully' });
    }

    const post = await prisma.post.update({
      where: { id: postId },
      data: {
        isHidden: action === 'hide',
        isReported: false,
        moderatedAt: new Date(),
        moderatedBy: adminId,
        moderationNote: note || null
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      }
    });

    res.json({
      message: `Post ${action === 'hide' ? 'hidden' : 'approved'} successfully`,
      post
    });
  } catch (error) {
    console.error('Error moderating post:', error);
    res.status(500).json({ error: 'Failed to moderate post' });
  }
});

/**
 * POST /admin/comments/:id/moderate
 * Moderate a comment (approve or hide)
 */
router.post('/comments/:id/moderate', async (req: AuthRequest, res) => {
  try {
    const commentId = parseInt(req.params.id);
    const { action, note } = req.body; // action: 'approve' | 'hide' | 'delete'
    const adminId = req.userId;

    if (!['approve', 'hide', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }

    if (action === 'delete') {
      await prisma.comment.delete({
        where: { id: commentId }
      });
      return res.json({ message: 'Comment deleted successfully' });
    }

    const comment = await prisma.comment.update({
      where: { id: commentId },
      data: {
        isHidden: action === 'hide',
        isReported: false,
        moderatedAt: new Date(),
        moderatedBy: adminId,
        moderationNote: note || null
      },
      include: {
        author: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      }
    });

    res.json({
      message: `Comment ${action === 'hide' ? 'hidden' : 'approved'} successfully`,
      comment
    });
  } catch (error) {
    console.error('Error moderating comment:', error);
    res.status(500).json({ error: 'Failed to moderate comment' });
  }
});

/**
 * GET /admin/users
 * Get all users with moderation info
 */
router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;
    const search = req.query.search as string;

    const where = search
      ? {
          OR: [
            { username: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { displayName: { contains: search, mode: 'insensitive' as const } }
          ]
        }
      : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          username: true,
          displayName: true,
          region: true,
          isAdmin: true,
          isBanned: true,
          bannedAt: true,
          bannedReason: true,
          createdAt: true,
          _count: {
            select: {
              posts: true,
              comments: true
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit
      }),
      prisma.user.count({ where })
    ]);

    res.json({
      users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * POST /admin/users/:id/ban
 * Ban a user
 */
router.post('/users/:id/ban', async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { reason } = req.body;

    if (userId === req.userId) {
      return res.status(400).json({ error: 'Cannot ban yourself' });
    }

    const targetUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { isAdmin: true }
    });

    if (targetUser?.isAdmin) {
      return res.status(403).json({ error: 'Cannot ban another admin' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        isBanned: true,
        bannedAt: new Date(),
        bannedReason: reason || 'Violation of community guidelines'
      },
      select: {
        id: true,
        username: true,
        email: true,
        isBanned: true,
        bannedAt: true,
        bannedReason: true
      }
    });

    res.json({
      message: 'User banned successfully',
      user
    });
  } catch (error) {
    console.error('Error banning user:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

/**
 * POST /admin/users/:id/unban
 * Unban a user
 */
router.post('/users/:id/unban', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        isBanned: false,
        bannedAt: null,
        bannedReason: null
      },
      select: {
        id: true,
        username: true,
        email: true,
        isBanned: true
      }
    });

    res.json({
      message: 'User unbanned successfully',
      user
    });
  } catch (error) {
    console.error('Error unbanning user:', error);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

/**
 * GET /admin/users/:id/details
 * Get detailed user information including followers, following, and messages
 */
router.get('/users/:id/details', async (req: AuthRequest, res) => {
  try {
    console.log('[Admin API] GET /admin/users/:id/details called');
    console.log('[Admin API] Request params:', req.params);
    console.log('[Admin API] Request user ID:', req.userId);
    
    const userId = parseInt(req.params.id);
    console.log('[Admin API] Parsed userId:', userId);
    
    if (isNaN(userId)) {
      console.error('[Admin API] Invalid userId - not a number');
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    console.log('[Admin API] Fetching user from database...');
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        region: true,
        isAdmin: true,
        isBanned: true,
        bannedAt: true,
        bannedReason: true,
        createdAt: true,
        _count: {
          select: {
            posts: true,
            comments: true,
            followers: true,
            following: true,
          }
        }
      }
    });

    if (!user) {
      console.error('[Admin API] User not found in database');
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('[Admin API] User found:', { id: user.id, email: user.email });
    console.log('[Admin API] Fetching followers...');
    
    // Get followers
    const followers = await prisma.follow.findMany({
      where: { followingId: userId },
      select: {
        follower: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            email: true,
          }
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    console.log('[Admin API] Followers fetched:', followers.length);

    console.log('[Admin API] Fetching following...');
    // Get following
    const following = await prisma.follow.findMany({
      where: { followerId: userId },
      select: {
        following: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            email: true,
          }
        },
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    console.log('[Admin API] Following fetched:', following.length);

    console.log('[Admin API] Fetching conversations...');
    // Get conversations (both as user1 and user2)
    const conversationsRaw = await prisma.conversation.findMany({
      where: {
        OR: [
          { user1Id: userId },
          { user2Id: userId }
        ]
      },
      select: {
        id: true,
        user1Id: true,
        user2Id: true,
        lastMessageAt: true,
        lastMessageText: true,
        user1: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            email: true,
          }
        },
        user2: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true,
            email: true,
          }
        },
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 20,
    });
    console.log('[Admin API] Conversations fetched:', conversationsRaw.length);

    console.log('[Admin API] Fetching messages for conversations...');
    // Get messages for each conversation
    const conversationsWithMessages = await Promise.all(
      conversationsRaw.map(async (conv) => {
        const messages = await prisma.message.findMany({
          where: {
            conversationId: conv.id,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            text: true,
            mediaUrl: true,
            mediaType: true,
            senderId: true,
            receiverId: true,
            isRead: true,
            createdAt: true,
          }
        });

        return {
          ...conv,
          messages,
        };
      })
    );
    console.log('[Admin API] Messages fetched for all conversations');

    console.log('[Admin API] Preparing response...');
    const response = {
      user,
      followers: followers.map(f => ({
        ...f.follower,
        followedAt: f.createdAt,
      })),
      following: following.map(f => ({
        ...f.following,
        followedAt: f.createdAt,
      })),
      conversations: conversationsWithMessages.map(conv => ({
        id: conv.id,
        otherUser: conv.user1Id === userId ? conv.user2 : conv.user1,
        lastMessageAt: conv.lastMessageAt,
        lastMessageText: conv.lastMessageText,
        messages: conv.messages,
      })),
    };
    
    console.log('[Admin API] Sending response with:', {
      followersCount: response.followers.length,
      followingCount: response.following.length,
      conversationsCount: response.conversations.length,
    });
    
    res.json(response);
  } catch (error) {
    console.error('[Admin API] Error fetching user details:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

/**
 * POST /admin/users/:id/make-admin
 * Grant admin privileges to a user
 */
router.post('/users/:id/make-admin', async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isAdmin: true },
      select: {
        id: true,
        username: true,
        email: true,
        isAdmin: true
      }
    });

    res.json({
      message: 'User granted admin privileges',
      user
    });
  } catch (error) {
    console.error('Error making user admin:', error);
    res.status(500).json({ error: 'Failed to grant admin privileges' });
  }
});

/**
 * POST /admin/users/:id/remove-admin
 * Remove admin privileges from a user
 */
router.post('/users/:id/remove-admin', async (req: AuthRequest, res) => {
  try {
    const userId = parseInt(req.params.id);

    if (userId === req.userId) {
      return res.status(400).json({ error: 'Cannot remove your own admin privileges' });
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data: { isAdmin: false },
      select: {
        id: true,
        username: true,
        email: true,
        isAdmin: true
      }
    });

    res.json({
      message: 'Admin privileges removed',
      user
    });
  } catch (error) {
    console.error('Error removing admin privileges:', error);
    res.status(500).json({ error: 'Failed to remove admin privileges' });
  }
});

export default router;