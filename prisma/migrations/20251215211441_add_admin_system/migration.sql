-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedBy" INTEGER,
ADD COLUMN     "moderationNote" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "moderatedAt" TIMESTAMP(3),
ADD COLUMN     "moderatedBy" INTEGER,
ADD COLUMN     "moderationNote" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bannedAt" TIMESTAMP(3),
ADD COLUMN     "bannedReason" TEXT,
ADD COLUMN     "isAdmin" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isBanned" BOOLEAN NOT NULL DEFAULT false;
