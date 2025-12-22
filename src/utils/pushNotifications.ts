import { Expo, ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk';
import { prisma } from '../prisma';

// Create a new Expo SDK client
const expo = new Expo();

export interface NotificationPayload {
  userId: number;
  title: string;
  body: string;
  data?: {
    type: 'message' | 'follow' | 'comment' | 'reaction' | 'mention';
    userId?: number;
    postId?: number;
    commentId?: number;
    conversationId?: number;
    [key: string]: any;
  };
}

/**
 * Send a push notification to a user
 */
export async function sendPushNotification(payload: NotificationPayload): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        pushToken: true,
        notificationsEnabled: true,
        notifyMessages: true,
        notifyConnections: true,
        notifyComments: true,
        notifyReactions: true,
        notifyMentions: true,
      },
    });

    if (!user || !user.pushToken || !user.notificationsEnabled) {
      console.log(`User ${payload.userId} has no push token or notifications disabled`);
      return false;
    }

    // Check user preferences based on notification type
    const notificationType = payload.data?.type;
    if (notificationType === 'message' && !user.notifyMessages) return false;
    if (notificationType === 'follow' && !user.notifyConnections) return false;
    if (notificationType === 'comment' && !user.notifyComments) return false;
    if (notificationType === 'reaction' && !user.notifyReactions) return false;
    if (notificationType === 'mention' && !user.notifyMentions) return false;

    // Check that the push token is valid
    if (!Expo.isExpoPushToken(user.pushToken)) {
      console.error(`Push token ${user.pushToken} is not a valid Expo push token`);
      return false;
    }

    // Construct the message
    const message: ExpoPushMessage = {
      to: user.pushToken,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data || {},
      priority: 'high',
      channelId: notificationType === 'message' ? 'messages' : 'social',
    };

    // Send the notification
    const chunks = expo.chunkPushNotifications([message]);
    const tickets: ExpoPushTicket[] = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error('Error sending push notification chunk:', error);
      }
    }

    // Check for errors in tickets
    for (const ticket of tickets) {
      if (ticket.status === 'error') {
        console.error(`Error sending notification: ${ticket.message}`);
        
        // If the token is invalid, remove it from the database
        if (ticket.details?.error === 'DeviceNotRegistered') {
          await prisma.user.update({
            where: { id: payload.userId },
            data: { pushToken: null, pushPlatform: null },
          });
        }
        return false;
      }
    }

    // Store notification in database for in-app display
    await prisma.notification.create({
      data: {
        userId: payload.userId,
        type: payload.data?.type || 'message',
        title: payload.title,
        body: payload.body,
        fromUserId: payload.data?.userId,
        postId: payload.data?.postId,
        commentId: payload.data?.commentId,
        conversationId: payload.data?.conversationId,
        data: payload.data ? JSON.parse(JSON.stringify(payload.data)) : null,
      },
    });

    return true;
  } catch (error) {
    console.error('Error in sendPushNotification:', error);
    return false;
  }
}

/**
 * Send push notifications to multiple users
 */
export async function sendBulkPushNotifications(
  payloads: NotificationPayload[]
): Promise<{ success: number; failed: number }> {
  const results = await Promise.allSettled(
    payloads.map((payload) => sendPushNotification(payload))
  );

  const success = results.filter(
    (r) => r.status === 'fulfilled' && r.value === true
  ).length;
  const failed = results.length - success;

  return { success, failed };
}

/**
 * Send notification when someone sends a message
 */
export async function notifyNewMessage(
  receiverId: number,
  senderId: number,
  senderName: string,
  messagePreview: string,
  conversationId: number
) {
  return sendPushNotification({
    userId: receiverId,
    title: `💬 ${senderName}`,
    body: messagePreview,
    data: {
      type: 'message',
      userId: senderId,
      conversationId,
    },
  });
}

/**
 * Send notification when someone follows you
 */
export async function notifyNewFollower(
  followedUserId: number,
  followerId: number,
  followerName: string
) {
  return sendPushNotification({
    userId: followedUserId,
    title: '👥 New Follower',
    body: `${followerName} started following you`,
    data: {
      type: 'follow',
      userId: followerId,
    },
  });
}

/**
 * Send notification when someone comments on your post
 */
export async function notifyNewComment(
  postAuthorId: number,
  commenterId: number,
  commenterName: string,
  postId: number,
  commentId: number,
  commentPreview: string
) {
  return sendPushNotification({
    userId: postAuthorId,
    title: `💬 ${commenterName} commented`,
    body: commentPreview,
    data: {
      type: 'comment',
      userId: commenterId,
      postId,
      commentId,
    },
  });
}

/**
 * Send notification when someone reacts to your post
 */
export async function notifyPostReaction(
  postAuthorId: number,
  reactorId: number,
  reactorName: string,
  postId: number,
  reactionType: 'upvote' | 'downvote'
) {
  const emoji = reactionType === 'upvote' ? '👍' : '👎';
  return sendPushNotification({
    userId: postAuthorId,
    title: `${emoji} ${reactorName}`,
    body: `${reactorName} ${reactionType}d your post`,
    data: {
      type: 'reaction',
      userId: reactorId,
      postId,
    },
  });
}

/**
 * Send notification when someone mentions you
 */
export async function notifyMention(
  mentionedUserId: number,
  mentionerId: number,
  mentionerName: string,
  postId: number,
  context: string
) {
  return sendPushNotification({
    userId: mentionedUserId,
    title: `@${mentionerName} mentioned you`,
    body: context,
    data: {
      type: 'mention',
      userId: mentionerId,
      postId,
    },
  });
}
