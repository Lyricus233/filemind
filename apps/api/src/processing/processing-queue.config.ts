import { ConfigService } from '@nestjs/config';

export function redisConnection(config: ConfigService, role: 'api' | 'worker') {
  const host = config.get<string>('REDIS_HOST', '127.0.0.1');
  const port = Number(config.get<string>('REDIS_PORT', '6379'));

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('REDIS_PORT must be an integer between 1 and 65535');
  }

  return {
    host,
    port,
    connectTimeout: 2000,
    maxRetriesPerRequest: role === 'worker' ? null : 1,
    enableOfflineQueue: role === 'worker',
  };
}
