// src/routes/posts.ts
import { Router } from "express";
import { prisma } from "../prisma";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { createPostLimiter, commentLimiter } from "../middleware/rateLimit";
import { POST_INCLUDE, mapPost } from "../utils/postMappers";
import { POST_REPORT_HIDE_THRESHOLD } from "../constants/moderation";

const router = Router();

// Helper function to extract hashtags from text
function extractHashtags(text: string): string[] {
  const hashtagRegex = /#[\w]+/g;
  const matches = text.match(hashtagRegex);
  if (!matches) return [];
  
  // Remove # and convert to lowercase, remove duplicates
  return [...new Set(matches.map(tag => tag.slice(1).toLowerCase()))];
}

// Helper function to create or link hashtags to a post
async function linkHashtagsToPost(postId: number, text: string) {
  const hashtags = extractHashtags(text);
  
  for (const tag of hashtags) {
    // Find or create hashtag
    let hashtag = await prisma.hashtag.findUnique({
      where: { tag },
    });
    
    if (!hashtag) {
      hashtag = await prisma.hashtag.create({
        data: { tag, useCount: 0 },
      });
    }
    
    // Link to post (if not already linked)
    const existing = await prisma.postHashtag.findUnique({
      where: {
        postId_hashtagId: {
          postId,
          hashtagId: hashtag.id,
        },
      },
    });
    
    if (!existing) {
      await prisma.postHashtag.create({
        data: {
          postId,
          hashtagId: hashtag.id,
        },
      });
      
      // Increment use count
      await prisma.hashtag.update({
        where: { id: hashtag.id },
        data: { useCount: { increment: 1 } },
      });
    }
  }
}




// GET /posts – visible posts (latest)
router.get("/", async (_req, res) => {
  try {
    const posts = await prisma.post.findMany({
      where: { isHidden: false },
      orderBy: { createdAt: "desc" },
      include: POST_INCLUDE,
    });

    res.json({ posts: posts.map(mapPost) });
  } catch (err) {
    console.error("GET /posts error:", err);
    res.status(500).json({ error: "Failed to load posts" });
  }
});

// GET /posts/hot – hottest posts (score = up-down + VS votes)
router.get("/hot", async (req, res) => {
  try {
    const regionParam = (req.query.region as string | undefined)?.trim() || null;

    const where: any = { isHidden: false };
    if (regionParam) {
      where.region = regionParam;
    }

    const posts = await prisma.post.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: POST_INCLUDE,
    });

    const ranked = posts
      .map((p) => {
        const vsVotes = p.votesA + p.votesB;
        const score = p.upvotes - p.downvotes + vsVotes;
        return { post: p, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.post);

    res.json({ posts: ranked.map(mapPost) });
  } catch (err) {
    console.error("GET /posts/hot error:", err);
    res.status(500).json({ error: "Failed to load hot posts" });
  }
});

// GET /posts/saved – posts current user saved
router.get("/saved", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const saved = await prisma.savedPost.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      include: {
        post: {
          include: POST_INCLUDE,
        },
      },
    });

    const posts = saved
      .map((sp) => sp.post)
      .filter((p) => !p.isHidden);

    res.json({ posts: posts.map(mapPost) });
  } catch (err) {
    console.error("GET /posts/saved error:", err);
    res.status(500).json({ error: "Failed to load saved posts" });
  }
});



router.post(
  "/",
  authMiddleware,
  createPostLimiter, // 👈 rate limit POST /posts
  async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) return res.status(401).json({ error: "Unauthorized" });

      const body = req.body ?? {};
      console.log("POST /posts body:", body);

      const type = (body.type ?? "").toString().trim();
      const title = (body.title ?? "").toString().trim();
      const textBody =
        body.body !== undefined && body.body !== null
          ? body.body.toString()
          : null;

      const sideA =
        body.sideA !== undefined && body.sideA !== null
          ? body.sideA.toString()
          : null;
      const sideB =
        body.sideB !== undefined && body.sideB !== null
          ? body.sideB.toString()
          : null;
      const isAnonymous =
        typeof body.isAnonymous === "boolean" ? body.isAnonymous : true;
      const region =
        body.region !== undefined && body.region !== null
          ? body.region.toString()
          : null;

      const mediaUrl =
        body.mediaUrl !== undefined && body.mediaUrl !== null
          ? body.mediaUrl.toString()
          : null;
      const mediaType =
        body.mediaType !== undefined && body.mediaType !== null
          ? body.mediaType.toString()
          : null;

      // Poll data
      const pollData = body.poll;

      // ---- basic input validation / low-effort guard ----

      if (!type || !title) {
        return res
          .status(400)
          .json({ error: "type and title are required fields" });
      }

      if (title.length < 4) {
        return res.status(400).json({
          error: "Title is too short. Add at least a few words.",
        });
      }

      if (title.length > 160) {
        return res.status(400).json({
          error: "Title is too long. Keep it under 160 characters.",
        });
      }

      if (textBody && textBody.length < 4) {
        return res.status(400).json({
          error: "Post body is too short. Add a bit more detail.",
        });
      }

      if (textBody && textBody.length > 4000) {
        return res.status(400).json({
          error: "Post body is too long. Keep it under ~4000 characters.",
        });
      }

      if (type === "VS") {
        if (!sideA || !sideB) {
          return res.status(400).json({
            error: "sideA and sideB are required for VS posts",
          });
        }
        if (sideA.length < 2 || sideB.length < 2) {
          return res.status(400).json({
            error: "Both sides in a VS post must be at least 2 characters.",
          });
        }
      }

      // Validate POLL type
      if (type === "POLL") {
        if (!pollData || !Array.isArray(pollData.options)) {
          return res.status(400).json({
            error: "Poll options are required for POLL posts",
          });
        }
        if (pollData.options.length < 3 || pollData.options.length > 6) {
          return res.status(400).json({
            error: "Polls must have between 3 and 6 options",
          });
        }
        for (const opt of pollData.options) {
          const optText = (opt ?? "").toString().trim();
          if (!optText || optText.length < 2 || optText.length > 100) {
            return res.status(400).json({
              error: "Each poll option must be 2-100 characters",
            });
          }
        }
      }

      // if no body & no image & very short title => probably low effort / spam
      if (!textBody && !mediaUrl && title.length < 10 && type !== "POLL") {
        return res.status(400).json({
          error:
            "Post seems too short. Add more detail or attach an image to make it interesting.",
        });
      }

      // Create post with poll if type is POLL
      const created = await prisma.$transaction(async (tx) => {
        const post = await tx.post.create({
          data: {
            type,
            title,
            body: textBody,
            sideA: sideA ?? undefined,
            sideB: sideB ?? undefined,
            isAnonymous,
            region: region ?? undefined,
            mediaUrl: mediaUrl ?? undefined,
            mediaType: mediaType ?? undefined,
            authorId: userId,
          },
        });

        // Create poll if type is POLL
        if (type === "POLL" && pollData) {
          const poll = await tx.poll.create({
            data: {
              postId: post.id,
              allowMultiple: pollData.allowMultiple ?? false,
              maxChoices: pollData.maxChoices ?? undefined,
              endsAt: pollData.endsAt ? new Date(pollData.endsAt) : undefined,
            },
          });
  
          // Create poll options
          await Promise.all(
            pollData.options.map((optText: string, index: number) =>
              tx.pollOption.create({
                data: {
                  pollId: poll.id,
                  text: optText.toString().trim(),
                  order: index,
                },
              })
            )
          );
        }
  
        // Extract and link hashtags from title and body
        const textToScan = `${title} ${textBody || ''}`;
        const hashtags = extractHashtags(textToScan);
        
        for (const tag of hashtags) {
          // Find or create hashtag
          let hashtag = await tx.hashtag.findUnique({
            where: { tag },
          });
          
          if (!hashtag) {
            hashtag = await tx.hashtag.create({
              data: { tag, useCount: 0 },
            });
          }
          
          // Link to post
          await tx.postHashtag.create({
            data: {
              postId: post.id,
              hashtagId: hashtag.id,
            },
          });
          
          // Increment use count
          await tx.hashtag.update({
            where: { id: hashtag.id },
            data: { useCount: { increment: 1 } },
          });
        }
  
        // Fetch complete post with includes
        return await tx.post.findUnique({
          where: { id: post.id },
          include: POST_INCLUDE,
        });
      });

      if (!created) {
        throw new Error("Failed to create post");
      }

      res.status(201).json({ post: mapPost(created) });
    } catch (err) {
      console.error("POST /posts error:", err);
      res.status(500).json({ error: "Failed to create post" });
    }
  }
);



// POST /posts/:id/comments  – create a comment or reply
router.post(
  "/:id/comments",
  authMiddleware,
  commentLimiter,
  async (req: AuthRequest, res) => {
    try {
      const userId = req.userId;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const idStr = req.params.id;
      const postId = Number(idStr);
      if (Number.isNaN(postId)) {
        return res.status(400).json({ error: "Invalid post id" });
      }

      const body = req.body ?? {};
      const text =
        typeof body.text === "string" ? body.text.trim() : "";
      const parentIdRaw = body.parentId;

      if (!text) {
        return res
          .status(400)
          .json({ error: "Comment text is required." });
      }
      if (text.length > 1000) {
        return res
          .status(400)
          .json({ error: "Comment must be at most 1000 characters." });
      }

      let parentId: number | null = null;
      if (
        parentIdRaw !== undefined &&
        parentIdRaw !== null &&
        !Number.isNaN(Number(parentIdRaw))
      ) {
        parentId = Number(parentIdRaw);
      }

      // 🔒 comments are never anonymous now
      const comment = await prisma.comment.create({
        data: {
          text,
          isAnonymous: false,
          likeCount: 0,
          isHidden: false,
          postId,
          authorId: userId,
          parentId: parentId ?? undefined,
        },
      });

      // reload full post with comments so client can refresh view
      const dbPost = await prisma.post.findUnique({
        where: { id: postId },
        include: POST_INCLUDE,
      });

      if (!dbPost) {
        return res.status(404).json({ error: "Post not found" });
      }

      const post = mapPost(dbPost);
      return res.status(201).json({ post });
    } catch (err) {
      console.error("POST /posts/:id/comments error:", err);

      const msg =
        (err as any)?.message?.includes("Too many requests")
          ? "You’re commenting too fast. Please slow down a little before adding more comments."
          : "Failed to add comment.";

      return res.status(429).json({ error: msg });
    }
  }
);



// POST /posts/:id/vs-vote – vote for Side A or B on a VS post
router.post("/:id/vs-vote", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const postId = Number(idStr);

    if (Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    const sideRaw = (req.body?.side ?? "").toString().toUpperCase();
    if (sideRaw !== "A" && sideRaw !== "B") {
      return res.status(400).json({ error: "side must be A or B" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const post = await tx.post.findUnique({
        where: { id: postId },
        select: { id: true },
      });

      if (!post) {
        throw new Error("POST_NOT_FOUND");
      }

      // one row per (userId, postId) in vsVote table
      const existing = await tx.vsVote.findFirst({
        where: { userId, postId },
      });

      if (!existing) {
        // first time voting on this poll
        await tx.vsVote.create({
          data: {
            userId,
            postId,
            side: sideRaw, // "A" or "B"
          },
        });
      } else if (existing.side === sideRaw) {
        // tap same side again -> unvote
        await tx.vsVote.delete({
          where: { id: existing.id },
        });
      } else {
        // switch A -> B or B -> A
        await tx.vsVote.update({
          where: { id: existing.id },
          data: { side: sideRaw },
        });
      }

      // recompute counts from vsVote table
      const [votesA, votesB] = await Promise.all([
        tx.vsVote.count({ where: { postId, side: "A" } }),
        tx.vsVote.count({ where: { postId, side: "B" } }),
      ]);

      const updated = await tx.post.update({
        where: { id: postId },
        data: {
          votesA,
          votesB,
        },
        select: {
          votesA: true,
          votesB: true,
        },
      });

      return updated;
    });

    // { votesA, votesB } shape – matches PostDetailScreen.tsx
    return res.json(result);
  } catch (err: any) {
    console.error("POST /posts/:id/vs-vote error:", err);
    if (err?.message === "POST_NOT_FOUND") {
      return res.status(404).json({ error: "Post not found" });
    }
    return res.status(500).json({ error: "Failed to record vote" });
  }
});

// POST /polls/:pollId/vote – vote on a multi-option poll
router.post("/polls/:pollId/vote", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const pollId = Number(req.params.pollId);
    if (Number.isNaN(pollId)) {
      return res.status(400).json({ error: "Invalid poll id" });
    }

    const body = req.body ?? {};
    const optionIds = body.optionIds;

    if (!Array.isArray(optionIds) || optionIds.length === 0) {
      return res.status(400).json({ error: "optionIds array is required" });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Get poll with settings
      const poll = await tx.poll.findUnique({
        where: { id: pollId },
        include: { options: true },
      });

      if (!poll) {
        throw new Error("POLL_NOT_FOUND");
      }

      // Check if poll has ended
      if (poll.endsAt && new Date() > poll.endsAt) {
        throw new Error("POLL_ENDED");
      }

      // Validate option IDs
      const validOptionIds = poll.options.map(o => o.id);
      const requestedIds = optionIds.map(id => Number(id));
      
      for (const id of requestedIds) {
        if (!validOptionIds.includes(id)) {
          throw new Error("INVALID_OPTION");
        }
      }

      // Check multiple selection rules
      if (!poll.allowMultiple && requestedIds.length > 1) {
        throw new Error("MULTIPLE_NOT_ALLOWED");
      }

      if (poll.allowMultiple && poll.maxChoices && requestedIds.length > poll.maxChoices) {
        throw new Error("TOO_MANY_CHOICES");
      }

      // Remove existing votes for this user on this poll
      await tx.pollVote.deleteMany({
        where: { userId, pollId },
      });

      // Add new votes
      await Promise.all(
        requestedIds.map(optionId =>
          tx.pollVote.create({
            data: { userId, pollId, optionId },
          })
        )
      );

      // Update vote counts for all options
      for (const option of poll.options) {
        const count = await tx.pollVote.count({
          where: { pollId, optionId: option.id },
        });
        await tx.pollOption.update({
          where: { id: option.id },
          data: { voteCount: count },
        });
      }

      // Update total votes
      const totalVotes = await tx.pollVote.count({
        where: { pollId },
      });
      await tx.poll.update({
        where: { id: pollId },
        data: { totalVotes },
      });

      // Return updated poll data
      const updatedPoll = await tx.poll.findUnique({
        where: { id: pollId },
        include: {
          options: {
            orderBy: { order: 'asc' },
          },
        },
      });

      return updatedPoll;
    });

    if (!result) {
      throw new Error("Failed to update poll");
    }

    // Format response
    const totalVotes = result.totalVotes;
    const options = result.options.map(opt => {
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
    });

    return res.json({
      poll: {
        id: String(result.id),
        totalVotes,
        options,
      },
    });
  } catch (err: any) {
    console.error("POST /polls/:pollId/vote error:", err);
    if (err?.message === "POLL_NOT_FOUND") {
      return res.status(404).json({ error: "Poll not found" });
    }
    if (err?.message === "POLL_ENDED") {
      return res.status(400).json({ error: "This poll has ended" });
    }
    if (err?.message === "INVALID_OPTION") {
      return res.status(400).json({ error: "Invalid poll option" });
    }
    if (err?.message === "MULTIPLE_NOT_ALLOWED") {
      return res.status(400).json({ error: "This poll only allows one selection" });
    }
    if (err?.message === "TOO_MANY_CHOICES") {
      return res.status(400).json({ error: "Too many options selected" });
    }
    return res.status(500).json({ error: "Failed to record vote" });
  }
});

// GET /posts/mine – posts created by the current user
router.get("/mine", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const posts = await prisma.post.findMany({
      where: {
        authorId: userId,
        isHidden: false,
      },
      orderBy: { createdAt: "desc" },
      include: POST_INCLUDE,
    });

    res.json({ posts: posts.map(mapPost) });
  } catch (err) {
    console.error("GET /posts/mine error:", err);
    res.status(500).json({ error: "Failed to load your posts" });
  }
});


// GET /posts/following - Uses connections instead of follow
router.get("/following", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Get accepted connections (Follow table doesn't exist in production)
    const connections = await prisma.connection.findMany({
      where: {
        OR: [
          { requesterId: userId, status: "ACCEPTED" },
          { receiverId: userId, status: "ACCEPTED" },
        ],
      },
      select: {
        requesterId: true,
        receiverId: true,
      },
    });

    // Extract the other user IDs from connections
    const connectedUserIds = connections.map((c) =>
      c.requesterId === userId ? c.receiverId : c.requesterId
    );

    // if user has no connections, return empty list
    if (connectedUserIds.length === 0) {
      return res.json({ posts: [] });
    }

    // Get posts from connected users (non-anonymous + not hidden)
    const posts = await prisma.post.findMany({
      where: {
        authorId: { in: connectedUserIds },
        isHidden: false,
        isAnonymous: false,
      },
      orderBy: { createdAt: "desc" },
      include: POST_INCLUDE,
    });

    return res.json({
      posts: posts.map(mapPost),
    });
  } catch (err) {
    console.error("GET /posts/following error:", err);
    return res
      .status(500)
      .json({ error: "Failed to load following feed" });
  }
});


// posts by a specific user (public profile feed)
router.get("/by-user/:userId", async (req, res) => {
  try {
    const userId = Number(req.params.userId);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const posts = await prisma.post.findMany({
      where: {
        authorId: userId,
        isHidden: false,
      },
      orderBy: { createdAt: "desc" },
      include: POST_INCLUDE,
    });

    res.json({ posts: posts.map(mapPost) });
  } catch (err) {
    console.error("GET /posts/by-user/:userId error:", err);
    res.status(500).json({ error: "Failed to load user posts" });
  }
});


// 📊 stats
router.get("/stats", async (_req, res) => {
  try {
    const posts = await prisma.post.findMany({
      where: { isHidden: false },
      include: {
        comments: {
          where: { isHidden: false },
        },
      },
    });

    const totalPosts = posts.length;
    const totalComments = posts.reduce(
      (sum, p) => sum + p.comments.length,
      0
    );

    const byType: Record<string, number> = {};
    const regionMap: Record<string, number> = {};

    let topPosts: {
      id: number;
      title: string;
      type: string;
      region: string | null;
      score: number;
      upvotes: number;
      downvotes: number;
      votesA: number;
      votesB: number;
    }[] = [];

    for (const p of posts) {
      byType[p.type] = (byType[p.type] || 0) + 1;

      if (p.region) {
        regionMap[p.region] = (regionMap[p.region] || 0) + 1;
      }

      const vsVotes = p.votesA + p.votesB;
      const score = p.upvotes - p.downvotes + vsVotes;

      topPosts.push({
        id: p.id,
        title: p.title,
        type: p.type,
        region: p.region ?? null,
        score,
        upvotes: p.upvotes,
        downvotes: p.downvotes,
        votesA: p.votesA,
        votesB: p.votesB,
      });
    }

    topPosts.sort((a, b) => b.score - a.score);
    topPosts = topPosts.slice(0, 5);

    const topRegions = Object.entries(regionMap)
      .map(([region, postCount]) => ({ region, postCount }))
      .sort((a, b) => b.postCount - a.postCount)
      .slice(0, 5);

    res.json({
      totalPosts,
      totalComments,
      byType,
      topRegions,
      topPosts,
    });
  } catch (err) {
    console.error("GET /posts/stats error:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});





// POST /posts/:id/report – report a post for moderation
router.post("/:id/report", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const postId = Number(idStr);

    if (Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    const existing = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!existing || existing.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    // increment report count + mark as reported
    const updated = await prisma.post.update({
      where: { id: postId },
      data: {
        isReported: true,
        reportedCount: { increment: 1 },
      },
    });

    let hidden = updated.isHidden;

    // auto-hide when threshold reached
    if (!updated.isHidden && updated.reportedCount >= POST_REPORT_HIDE_THRESHOLD) {
      await prisma.post.update({
        where: { id: postId },
        data: { isHidden: true },
      });
      hidden = true;
    }

    // frontend already removes the post from lists, it only needs "ok"
    return res.json({
      ok: true,
      hidden,
      reportedCount: updated.reportedCount,
    });
  } catch (err) {
    console.error("POST /posts/:id/report error:", err);
    return res.status(500).json({ error: "Failed to report post" });
  }
});





// POST /posts/:id/save – toggle saved (bookmark) for current user
router.post("/:id/save", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const postId = Number(req.params.id);
    if (Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    // make sure post exists & is not hidden
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post || post.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    const existing = await prisma.savedPost.findUnique({
      where: { userId_postId: { userId, postId } },
    });

    let saved = false;

    if (!existing) {
      // create bookmark
      await prisma.savedPost.create({
        data: { userId, postId },
      });
      saved = true;
    } else {
      // remove bookmark
      await prisma.savedPost.delete({
        where: { id: existing.id },
      });
      saved = false;
    }

    res.json({ ok: true, saved });
  } catch (err) {
    console.error("POST /posts/:id/save error:", err);
    res.status(500).json({ error: "Failed to toggle save" });
  }
});

// DELETE /posts/:id – soft delete (hide) a post by its author
router.delete("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const postId = Number(idStr);

    if (Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    // Make sure the post exists
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post || post.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Only the author can delete
    if (post.authorId !== userId) {
      return res
        .status(403)
        .json({ error: "You can only delete your own posts." });
    }

    // Soft-delete: mark as hidden
    await prisma.post.update({
      where: { id: postId },
      data: { isHidden: true },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /posts/:id error:", err);
    return res.status(500).json({ error: "Failed to delete post." });
  }
});

// GET /posts/:id – full details for one post
router.get("/:id", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const idStr = req.params.id;
    const postId = Number(idStr);

    if (Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    const dbPost = await prisma.post.findUnique({
      where: { id: postId },
      include: POST_INCLUDE,
    });

    // if it doesn't exist OR is hidden, treat as 404
    if (!dbPost || dbPost.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    const post = mapPost(dbPost);
    return res.json({ post });
  } catch (err) {
    console.error("GET /posts/:id error:", err);
    return res
      .status(500)
      .json({ error: "Failed to load post." });
  }
});


// POST /posts/:id/react – unified reaction endpoint (🔥 UPVOTE / 🧊 DOWNVOTE toggle)
router.post("/:id/react", authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const idStr = req.params.id;
    const postId = Number(idStr);

    if (!postId || Number.isNaN(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }

    const body = req.body ?? {};
    const typeRaw = (body.type ?? "").toString().toUpperCase();

    if (typeRaw !== "UPVOTE" && typeRaw !== "DOWNVOTE") {
      return res
        .status(400)
        .json({ error: "type must be UPVOTE or DOWNVOTE" });
    }

    // make sure post exists and not hidden
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { id: true, isHidden: true },
    });

    if (!post || post.isHidden) {
      return res.status(404).json({ error: "Post not found" });
    }

    // find any existing reaction from this user on this post
    const existing = await prisma.postReaction.findUnique({
      where: {
        userId_postId: {
          userId,
          postId,
        },
      },
    });

    if (existing && existing.type === typeRaw) {
      // same reaction already set -> remove (toggle off)
      await prisma.postReaction.delete({ where: { id: existing.id } });
    } else if (existing) {
      // switch reaction
      await prisma.postReaction.update({
        where: { id: existing.id },
        data: { type: typeRaw as any },
      });
    } else {
      // create new reaction
      await prisma.postReaction.create({
        data: {
          userId,
          postId,
          type: typeRaw as any,
        },
      });
    }

    // recalc counts to keep Post table accurate
    const [upvotes, downvotes] = await Promise.all([
      prisma.postReaction.count({
        where: { postId, type: "UPVOTE" as any },
      }),
      prisma.postReaction.count({
        where: { postId, type: "DOWNVOTE" as any },
      }),
    ]);

    const updated = await prisma.post.update({
      where: { id: postId },
      data: {
        upvotes,
        downvotes,
      },
    });

    return res.json({
      ok: true,
      upvotes,
      downvotes,
      score: updated.upvotes - updated.downvotes,
    });
  } catch (err) {
    console.error("POST /posts/:id/react error:", err);
    return res.status(500).json({ error: "Failed to react to post" });
  }
});

// ----------------------------------------------------
//  HASHTAG ENDPOINTS
// ----------------------------------------------------

// GET /posts/hashtags/trending - Get trending hashtags
router.get("/hashtags/trending", async (_req, res) => {
  try {
    const hashtags = await prisma.hashtag.findMany({
      orderBy: { useCount: "desc" },
      take: 20,
    });

    res.json({
      hashtags: hashtags.map(h => ({
        tag: h.tag,
        useCount: h.useCount,
      })),
    });
  } catch (err) {
    console.error("GET /posts/hashtags/trending error:", err);
    res.status(500).json({ error: "Failed to load trending hashtags" });
  }
});

// GET /posts/hashtags/:tag - Get posts with a specific hashtag
router.get("/hashtags/:tag", async (req, res) => {
  try {
    const tag = req.params.tag.toLowerCase().replace(/^#/, '');
    
    const postHashtags = await prisma.postHashtag.findMany({
      where: {
        hashtag: { tag },
      },
      include: {
        post: {
          where: { isHidden: false },
          include: POST_INCLUDE,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const posts = postHashtags
      .map(ph => ph.post)
      .filter(p => p !== null);

    res.json({ posts: posts.map(mapPost) });
  } catch (err) {
    console.error("GET /posts/hashtags/:tag error:", err);
    res.status(500).json({ error: "Failed to load posts for hashtag" });
  }
});

export default router;
