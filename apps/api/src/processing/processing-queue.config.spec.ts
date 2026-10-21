import { ConfigService } from '@nestjs/config';

import { redisConnection } from './processing-queue.config.js';

describe('redisConnection', () => {
  it('uses bounded command retries and no offline buffering for the API', () => {
    const config = new ConfigService({
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
    });
    expect(redisConnection(config, 'api')).toMatchObject({
      host: '127.0.0.1',
      port: 6379,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
  });

  it('allows the worker to reconnect and resume waiting', () => {
    const config = new ConfigService({
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: '6379',
    });
    expect(redisConnection(config, 'worker')).toMatchObject({
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
  });

  it.each(['abc', '0', '65536', '6379.5'])(
    'rejects invalid Redis port %s',
    (port) => {
      expect(() =>
        redisConnection(new ConfigService({ REDIS_PORT: port }), 'api'),
      ).toThrow('REDIS_PORT must be an integer between 1 and 65535');
    },
  );
});
