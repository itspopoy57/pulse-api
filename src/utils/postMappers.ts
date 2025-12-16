// src/utils/postMappers.ts
// Utilities for mapping database posts to API response format

export const POST_INCLUDE = {
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
  poll: {
    include: {
      options: {
        orderBy: { order: 'asc' as const },
      },
    },
  },
};

/**
 * Build nested comment tree from flat list
 */
export function buildCommentTree(comments: any[]): any[] {
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

/**
 * Map single comment (with nested replies) to API format
 */
export function mapComment(c: any): any {
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

/**
 * Map database post to API response format
 */
export function mapPost(post: any): any {
  const tree = buildCommentTree(post.comments || []);

  // Map poll data if present
  let poll = undefined;
  if (post.poll) {
    const totalVotes = post.poll.totalVotes || 0;
    poll = {
      id: String(post.poll.id),
      totalVotes,
      allowMultiple: post.poll.allowMultiple,
      maxChoices: post.poll.maxChoices ?? undefined,
      endsAt: post.poll.endsAt?.toISOString() ?? undefined,
      hasEnded: post.poll.endsAt ? new Date() > post.poll.endsAt : false,
      options: (post.poll.options || []).map((opt: any) => {
        const percentage = totalVotes > 0
          ? Math.round((opt.voteCount / totalVotes) * 100)
          : 0;
        return {
          id: String(opt.id),
          text: opt.text,
          voteCount: opt.voteCount,
          percentage,
          order: opt.order,
        };
      }),
    };
  }

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

    // Author info for profiles
    authorId: String(post.authorId),
    authorName: post.isAnonymous
      ? "Anonymous"
      : post.author?.username || post.author?.email || "User",

    // Media support
    mediaUrl: post.mediaUrl ?? undefined,
    mediaType: post.mediaType ?? undefined,

    // Poll data
    poll,

    comments: tree.map(mapComment),
    createdAt: post.createdAt.toISOString(),
  };
}