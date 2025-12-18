import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { sendPushNotification } from '../utils/pushNotifications';

const router = Router();
const prisma = new PrismaClient();

// Get all groups for the current user
router.get('/', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;

    const groups = await prisma.group.findMany({
      where: {
        members: {
          some: {
            userId
          }
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        },
        creator: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        },
        _count: {
          select: {
            members: true,
            messages: true
          }
        }
      },
      orderBy: {
        lastMessageAt: 'desc'
      }
    });

    // Get unread count for each group
    const groupsWithUnread = await Promise.all(
      groups.map(async (group) => {
        const member = group.members.find(m => m.userId === userId);
        
        // Count unread messages (messages after user joined that they haven't read)
        const unreadCount = await prisma.groupMessage.count({
          where: {
            groupId: group.id,
            createdAt: {
              gte: member?.joinedAt
            },
            senderId: {
              not: userId
            },
            isDeleted: false,
            NOT: {
              reads: {
                some: {
                  userId
                }
              }
            }
          }
        });

        return {
          ...group,
          unreadCount,
          isMuted: member?.isMuted || false,
          userRole: member?.role || 'MEMBER'
        };
      })
    );

    res.json(groupsWithUnread);
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

// Get a specific group
router.get('/:groupId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true,
                createdAt: true
              }
            }
          },
          orderBy: {
            joinedAt: 'asc'
          }
        },
        creator: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Check if user is a member
    const isMember = group.members.some(m => m.userId === userId);
    if (!isMember) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const member = group.members.find(m => m.userId === userId);

    res.json({
      ...group,
      isMuted: member?.isMuted || false,
      userRole: member?.role || 'MEMBER'
    });
  } catch (error) {
    console.error('Error fetching group:', error);
    res.status(500).json({ error: 'Failed to fetch group' });
  }
});

// Create a new group
router.post('/', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const { name, description, avatarUrl, memberIds } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Group name is required' });
    }

    if (name.length > 100) {
      return res.status(400).json({ error: 'Group name must be 100 characters or less' });
    }

    // Validate member IDs
    if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'At least one member is required' });
    }

    // Check if all members exist
    const members = await prisma.user.findMany({
      where: {
        id: {
          in: memberIds
        }
      }
    });

    if (members.length !== memberIds.length) {
      return res.status(400).json({ error: 'Some members do not exist' });
    }

    // Create group with creator and members
    const group = await prisma.group.create({
      data: {
        name: name.trim(),
        description: description?.trim(),
        avatarUrl,
        creatorId: userId,
        members: {
          create: [
            // Creator as admin
            {
              userId,
              role: 'ADMIN'
            },
            // Other members
            ...memberIds
              .filter((id: number) => id !== userId)
              .map((id: number) => ({
                userId: id,
                role: 'MEMBER'
              }))
          ]
        }
      },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        },
        creator: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });

    // Send notifications to added members
    const creator = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, displayName: true }
    });

    const creatorName = creator?.displayName || creator?.username || 'Someone';

    for (const memberId of memberIds) {
      if (memberId !== userId) {
        // Create notification
        await prisma.notification.create({
          data: {
            userId: memberId,
            type: 'group_invite',
            title: 'Added to Group',
            body: `${creatorName} added you to "${name}"`,
            fromUserId: userId,
            groupId: group.id,
            data: {
              groupId: group.id,
              groupName: name
            }
          }
        });

        // Send push notification
        const member = await prisma.user.findUnique({
          where: { id: memberId },
          select: { pushToken: true, notificationsEnabled: true }
        });

        if (member?.pushToken && member.notificationsEnabled) {
          await sendPushNotification(
            member.pushToken,
            'Added to Group',
            `${creatorName} added you to "${name}"`,
            { groupId: group.id.toString(), type: 'group_invite' }
          );
        }
      }
    }

    res.status(201).json(group);
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

// Update group settings (name, description, avatar)
router.patch('/:groupId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const { name, description, avatarUrl } = req.body;

    // Check if user is an admin of the group
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member || member.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can update group settings' });
    }

    const updateData: any = {};
    if (name !== undefined) {
      if (name.trim().length === 0) {
        return res.status(400).json({ error: 'Group name cannot be empty' });
      }
      if (name.length > 100) {
        return res.status(400).json({ error: 'Group name must be 100 characters or less' });
      }
      updateData.name = name.trim();
    }
    if (description !== undefined) {
      updateData.description = description?.trim() || null;
    }
    if (avatarUrl !== undefined) {
      updateData.avatarUrl = avatarUrl || null;
    }

    const group = await prisma.group.update({
      where: { id: groupId },
      data: updateData,
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        },
        creator: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });

    res.json(group);
  } catch (error) {
    console.error('Error updating group:', error);
    res.status(500).json({ error: 'Failed to update group' });
  }
});

// Add members to group
router.post('/:groupId/members', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const { memberIds } = req.body;

    if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0) {
      return res.status(400).json({ error: 'Member IDs are required' });
    }

    // Check if user is an admin of the group
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member || member.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can add members' });
    }

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { name: true }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Check if users exist
    const users = await prisma.user.findMany({
      where: {
        id: {
          in: memberIds
        }
      }
    });

    if (users.length !== memberIds.length) {
      return res.status(400).json({ error: 'Some users do not exist' });
    }

    // Add members (skip if already exists)
    const newMembers = [];
    for (const memberId of memberIds) {
      try {
        const newMember = await prisma.groupMember.create({
          data: {
            groupId,
            userId: memberId,
            role: 'MEMBER'
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        });
        newMembers.push(newMember);

        // Send notification
        const adder = await prisma.user.findUnique({
          where: { id: userId },
          select: { username: true, displayName: true }
        });

        const adderName = adder?.displayName || adder?.username || 'Someone';

        await prisma.notification.create({
          data: {
            userId: memberId,
            type: 'group_invite',
            title: 'Added to Group',
            body: `${adderName} added you to "${group.name}"`,
            fromUserId: userId,
            groupId,
            data: {
              groupId,
              groupName: group.name
            }
          }
        });

        // Send push notification
        const user = await prisma.user.findUnique({
          where: { id: memberId },
          select: { pushToken: true, notificationsEnabled: true }
        });

        if (user?.pushToken && user.notificationsEnabled) {
          await sendPushNotification(
            user.pushToken,
            'Added to Group',
            `${adderName} added you to "${group.name}"`,
            { groupId: groupId.toString(), type: 'group_invite' }
          );
        }
      } catch (error) {
        // Member already exists, skip
        console.log(`Member ${memberId} already in group ${groupId}`);
      }
    }

    res.json({ added: newMembers });
  } catch (error) {
    console.error('Error adding members:', error);
    res.status(500).json({ error: 'Failed to add members' });
  }
});

// Remove member from group
router.delete('/:groupId/members/:memberId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const memberId = parseInt(req.params.memberId);

    // Check if user is an admin of the group or removing themselves
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    const isAdmin = member?.role === 'ADMIN';
    const isSelf = userId === memberId;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: 'Only admins can remove members' });
    }

    // Check if trying to remove the creator
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { creatorId: true }
    });

    if (group?.creatorId === memberId && !isSelf) {
      return res.status(403).json({ error: 'Cannot remove the group creator' });
    }

    // Remove member
    await prisma.groupMember.delete({
      where: {
        groupId_userId: {
          groupId,
          userId: memberId
        }
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

// Update member role (promote/demote admin)
router.patch('/:groupId/members/:memberId/role', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const memberId = parseInt(req.params.memberId);
    const { role } = req.body;

    if (!role || !['ADMIN', 'MEMBER'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if user is an admin of the group
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member || member.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Only admins can change member roles' });
    }

    // Update member role
    const updatedMember = await prisma.groupMember.update({
      where: {
        groupId_userId: {
          groupId,
          userId: memberId
        }
      },
      data: { role },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });

    res.json(updatedMember);
  } catch (error) {
    console.error('Error updating member role:', error);
    res.status(500).json({ error: 'Failed to update member role' });
  }
});

// Mute/unmute group
router.patch('/:groupId/mute', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const { isMuted } = req.body;

    if (typeof isMuted !== 'boolean') {
      return res.status(400).json({ error: 'isMuted must be a boolean' });
    }

    const member = await prisma.groupMember.update({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      },
      data: { isMuted }
    });

    res.json({ isMuted: member.isMuted });
  } catch (error) {
    console.error('Error updating mute status:', error);
    res.status(500).json({ error: 'Failed to update mute status' });
  }
});

// Delete group (admin only)
router.delete('/:groupId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);

    // Check if user is the creator
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { creatorId: true }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    if (group.creatorId !== userId) {
      return res.status(403).json({ error: 'Only the group creator can delete the group' });
    }

    // Delete group (cascade will handle members and messages)
    await prisma.group.delete({
      where: { id: groupId }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting group:', error);
    res.status(500).json({ error: 'Failed to delete group' });
  }
});

// Get group messages
router.get('/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const limit = parseInt(req.query.limit as string) || 50;
    const before = req.query.before ? parseInt(req.query.before as string) : undefined;

    // Check if user is a member
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const messages = await prisma.groupMessage.findMany({
      where: {
        groupId,
        isDeleted: false,
        createdAt: {
          gte: member.joinedAt
        },
        ...(before && {
          id: {
            lt: before
          }
        })
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        },
        reads: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                displayName: true,
                avatarUrl: true
              }
            }
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: limit
    });

    res.json(messages.reverse());
  } catch (error) {
    console.error('Error fetching group messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Send a group message
router.post('/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const { text, mediaUrl, mediaType, fileName } = req.body;

    if (!text && !mediaUrl) {
      return res.status(400).json({ error: 'Message must have text or media' });
    }

    // Check if user is a member
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Create message
    const message = await prisma.groupMessage.create({
      data: {
        groupId,
        senderId: userId,
        text: text?.trim(),
        mediaUrl,
        mediaType,
        fileName
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        },
        reads: true
      }
    });

    // Update group's last message
    await prisma.group.update({
      where: { id: groupId },
      data: {
        lastMessageAt: message.createdAt,
        lastMessageText: text?.substring(0, 100) || (mediaUrl ? '📷 Photo' : '')
      }
    });

    // Mark as read by sender
    await prisma.groupMessageRead.create({
      data: {
        messageId: message.id,
        userId
      }
    });

    // Get group info and members
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: {
        members: {
          where: {
            userId: {
              not: userId
            },
            isMuted: false
          },
          include: {
            user: {
              select: {
                id: true,
                pushToken: true,
                notificationsEnabled: true,
                notifyMessages: true
              }
            }
          }
        }
      }
    });

    const sender = await prisma.user.findUnique({
      where: { id: userId },
      select: { username: true, displayName: true }
    });

    const senderName = sender?.displayName || sender?.username || 'Someone';

    // Send notifications to other members
    if (group) {
      for (const groupMember of group.members) {
        const user = groupMember.user;
        
        // Create notification
        await prisma.notification.create({
          data: {
            userId: user.id,
            type: 'group_message',
            title: group.name,
            body: `${senderName}: ${text?.substring(0, 100) || '📷 Photo'}`,
            fromUserId: userId,
            groupId,
            data: {
              groupId,
              messageId: message.id
            }
          }
        });

        // Send push notification
        if (user.pushToken && user.notificationsEnabled && user.notifyMessages) {
          await sendPushNotification(
            user.pushToken,
            group.name,
            `${senderName}: ${text?.substring(0, 100) || '📷 Photo'}`,
            { groupId: groupId.toString(), messageId: message.id.toString(), type: 'group_message' }
          );
        }
      }
    }

    res.status(201).json(message);
  } catch (error) {
    console.error('Error sending group message:', error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Mark messages as read
router.post('/:groupId/messages/read', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({ error: 'messageIds array is required' });
    }

    // Check if user is a member
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Mark messages as read (skip if already read)
    const reads = [];
    for (const messageId of messageIds) {
      try {
        const read = await prisma.groupMessageRead.create({
          data: {
            messageId,
            userId
          }
        });
        reads.push(read);
      } catch (error) {
        // Already read, skip
      }
    }

    res.json({ markedRead: reads.length });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Update typing indicator
router.post('/:groupId/typing', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);

    // Check if user is a member
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    // Upsert typing indicator
    await prisma.groupTyping.upsert({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      },
      create: {
        groupId,
        userId
      },
      update: {
        updatedAt: new Date()
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating typing indicator:', error);
    res.status(500).json({ error: 'Failed to update typing indicator' });
  }
});

// Get typing users (remove stale indicators older than 5 seconds)
router.get('/:groupId/typing', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);

    // Check if user is a member
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    if (!member) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const fiveSecondsAgo = new Date(Date.now() - 5000);

    // Delete stale typing indicators
    await prisma.groupTyping.deleteMany({
      where: {
        groupId,
        updatedAt: {
          lt: fiveSecondsAgo
        }
      }
    });

    // Get active typing users (excluding self)
    const typingUsers = await prisma.groupTyping.findMany({
      where: {
        groupId,
        userId: {
          not: userId
        },
        updatedAt: {
          gte: fiveSecondsAgo
        }
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            avatarUrl: true
          }
        }
      }
    });

    res.json(typingUsers.map(t => t.user));
  } catch (error) {
    console.error('Error fetching typing users:', error);
    res.status(500).json({ error: 'Failed to fetch typing users' });
  }
});

// Delete a message (soft delete)
router.delete('/:groupId/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const userId = (req as AuthRequest).userId!;
    const groupId = parseInt(req.params.groupId);
    const messageId = parseInt(req.params.messageId);

    // Get message
    const message = await prisma.groupMessage.findUnique({
      where: { id: messageId }
    });

    if (!message || message.groupId !== groupId) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Check if user is sender or admin
    const member = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId,
          userId
        }
      }
    });

    const isSender = message.senderId === userId;
    const isAdmin = member?.role === 'ADMIN';

    if (!isSender && !isAdmin) {
      return res.status(403).json({ error: 'Only the sender or admins can delete messages' });
    }

    // Soft delete
    await prisma.groupMessage.update({
      where: { id: messageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: userId
      }
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

export default router;
