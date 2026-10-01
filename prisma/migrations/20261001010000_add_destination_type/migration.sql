ALTER TABLE "Destination" ADD COLUMN "type" "Provider";
UPDATE "Destination" SET "type" = 'WHATSAPP';
ALTER TABLE "Destination" ALTER COLUMN "type" SET NOT NULL;

DROP INDEX "Destination_isActive_idx";
CREATE INDEX "Destination_type_isActive_idx" ON "Destination"("type", "isActive");
