-- CreateEnum
CREATE TYPE "PrepShipmentStatus" AS ENUM ('Pending', 'Prepped', 'Shipped');

-- CreateTable
CREATE TABLE "PrepShipment" (
    "id" TEXT NOT NULL,
    "shipment_id" TEXT NOT NULL,
    "units" INTEGER NOT NULL,
    "status" "PrepShipmentStatus" NOT NULL DEFAULT 'Pending',
    "shop_origin" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrepShipment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PrepShipment_shipment_id_shop_origin_key" ON "PrepShipment"("shipment_id", "shop_origin");

-- CreateIndex
CREATE INDEX "PrepShipment_shop_origin_idx" ON "PrepShipment"("shop_origin");

-- AddForeignKey
ALTER TABLE "PrepShipment" ADD CONSTRAINT "PrepShipment_shop_origin_fkey" FOREIGN KEY ("shop_origin") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
