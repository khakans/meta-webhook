function readPositiveInt(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export const config = {
  get databaseUrl() {
    return requiredEnv('DATABASE_URL');
  },
  get adminApiKey() {
    return requiredEnv('ADMIN_API_KEY');
  },
  get encryptionKey() {
    const encoded = requiredEnv('GATEWAY_ENCRYPTION_KEY');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32) {
      throw new Error(
        'GATEWAY_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
      );
    }
    return key;
  },
  workerPollMs: () => readPositiveInt('WORKER_POLL_MS', 500),
  workerBatchSize: () =>
    Math.min(readPositiveInt('WORKER_BATCH_SIZE', 10), 100),
  deliveryMaxAttempts: () =>
    Math.min(readPositiveInt('DELIVERY_MAX_ATTEMPTS', 8), 20),
  allowHttpDestinations: () => process.env.ALLOW_HTTP_DESTINATIONS === 'true',
  destinationHostAllowlist: () =>
    new Set(
      (process.env.DESTINATION_HOST_ALLOWLIST ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
};

export function validateApiEnvironment() {
  void config.databaseUrl;
  void config.adminApiKey;
  void config.encryptionKey;
}

export function validateWorkerEnvironment() {
  void config.databaseUrl;
  void config.encryptionKey;
}
