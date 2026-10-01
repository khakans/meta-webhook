ALTER TABLE "WebhookEndpoint"
  ALTER COLUMN "provider" TYPE TEXT USING lower("provider"::text);

ALTER TABLE "WebhookEvent"
  ALTER COLUMN "provider" TYPE TEXT USING lower("provider"::text);

ALTER TABLE "Destination"
  ALTER COLUMN "type" TYPE TEXT USING lower("type"::text);

DROP TYPE IF EXISTS "Provider";
