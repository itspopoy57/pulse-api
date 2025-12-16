import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma';

export interface AdminRequest extends Request {
  userId?: number;
  isAdmin?: boolean;
}

/**
 * Middleware to check if the authenticated user is an admin
 * Must be used after the auth middleware
 */
export const requireAdmin = async (
  req: AdminRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (!req.userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if ((user as any).isBanned) {
      return res.status(403).json({ error: 'Your account has been banned' });
    }

    if (!(user as any).isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.isAdmin = true;
    next();
  } catch (error) {
    console.error('Admin middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};