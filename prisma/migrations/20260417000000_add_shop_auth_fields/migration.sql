-- AlterTable
ALTER TABLE "Shop"
ADD COLUMN "accessToken" TEXT,
ADD COLUMN "grantedScopes" TEXT,
ADD COLUMN "installedAt" TIMESTAMP(3);
