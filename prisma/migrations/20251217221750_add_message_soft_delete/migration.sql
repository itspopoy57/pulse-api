-- AlterTable
ALTER TABLE "Message" ADD COLUMN "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "deletedAt" TIMESTAMP(3),
ADD COLUMN "deletedBy" INTEGER;

-- CreateIndex
CREATE INDEX "Message_isDeleted_idx" ON "Message"("isDeleted");
