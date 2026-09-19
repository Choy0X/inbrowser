import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createClient } from 'redis';
import { rateLimit, RedisLease, RedisUnavailable, SharedRedis } from '../src/redis.ts';

// This intentionally fills a disposable Redis process. Never point it at the
// shared integration server or a deployment. Example isolated server:
// docker run --rm -p 127.0.0.1:16381:6379 redis:7-alpine redis-server \
//   --save "" --appendonly no --maxmemory 4mb --maxmemory-policy noeviction
// Set TEST_REDIS_OOM_URL=redis://127.0.0.1:16381 and
// TEST_REDIS_OOM_ALLOW_PRESSURE=1 to opt in. No CONFIG SET or FLUSH commands.
const url = process.env.TEST_REDIS_OOM_URL;
const enabled = Boolean(url) && process.env.TEST_REDIS_OOM_ALLOW_PRESSURE === '1';

test('noeviction preserves an existing lease and fails closed under OOM, then recovers after pressure is removed', {
  skip: enabled ? false : 'Requires an explicitly authorized disposable Redis memory-pressure instance.',
  timeout: 20_000,
}, async t => {
  const endpoint = new URL(url!);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname), 'Memory-pressure tests require a local disposable instance.');
  assert.ok(endpoint.port && !['6379', '6380', '16380'].includes(endpoint.port), 'Do not use the normal deployment or shared integration Redis port.');
  const prefix = `inbrowser-oom-test:${randomUUID()}:`;
  const password = process.env.TEST_REDIS_OOM_PASSWORD;
  const raw = createClient({ url, password, socket: { connectTimeout: 2000, reconnectStrategy: false } });
  raw.on('error', () => {});
  const redis = new SharedRedis({ url: url!, password, keyPrefix: prefix, commandTimeoutMs: 500 });
  const pressureKeys: string[] = [];
  let lease: RedisLease | null = null;
  t.after(async () => {
    try {
      if (raw.isReady) {
        if (pressureKeys.length) await raw.sendCommand(['DEL', ...pressureKeys]);
        let cursor = '0';
        do {
          const page = await raw.sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '100']) as [string, string[]];
          cursor = page[0];
          if (page[1].length) await raw.sendCommand(['DEL', ...page[1]]);
        } while (cursor !== '0');
      }
    } finally {
      await lease?.release();
      await redis.close();
      if (raw.isOpen) raw.destroy();
    }
  });
  await raw.connect();
  assert.equal(await raw.dbSize(), 0, 'The disposable instance must be empty before applying pressure.');
  const configuration = await raw.configGet(['maxmemory', 'maxmemory-policy']);
  const maxmemory = Number(configuration.maxmemory);
  assert.ok(maxmemory >= 2 * 1024 * 1024 && maxmemory <= 16 * 1024 * 1024, 'Use a disposable instance configured with 2-16 MiB maxmemory.');
  assert.equal(configuration['maxmemory-policy'], 'noeviction');
  redis.start();
  assert.equal(await redis.waitReady(5000), true);

  lease = await RedisLease.acquire(redis, 'catalog-job', 60_000);
  assert.ok(lease);
  await lease.setJson('published', { generation: 'before-pressure' }, 60);
  const secret = 'memory-pressure-test-secret';
  const clientIp = '203.0.113.81';
  const rateKey = redis.key(`rate:relay:${createHmac('sha256', secret).update(`rate:relay:${clientIp}`).digest('hex')}`);
  assert.equal((await rateLimit(redis, secret, clientIp, 10)).limited, false);

  const pressureKey = redis.key('pressure');
  pressureKeys.push(pressureKey);
  // Redis permits the remaining writes of a script once its first write was
  // admitted. Use that behavior only in this disposable fixture to create
  // sustained stored-data pressure, rather than transient client-buffer OOM.
  await raw.eval("redis.call('SET',KEYS[1],'seed'); return redis.call('APPEND',KEYS[1],string.rep('p',tonumber(ARGV[1])))", {
    keys: [pressureKey], arguments: [String(maxmemory)],
  });
  await assert.rejects(raw.set(redis.key('oom-probe'), '1'), error =>
    error instanceof Error && /^OOM\b/.test(error.message));
  const used = /^used_memory:(\d+)\r?$/m.exec(await raw.info('memory'));
  assert.ok(Number(used?.[1]) > maxmemory, 'Pressure must persist after command buffers are released.');
  assert.equal(await raw.get(lease.key), lease.token, 'noeviction must retain the current lease owner.');

  await assert.rejects(rateLimit(redis, secret, clientIp, 10), RedisUnavailable);
  await assert.rejects(rateLimit(redis, secret, '203.0.113.82', 10), RedisUnavailable);
  assert.equal(await raw.get(rateKey), '1', 'A rejected counter operation must not increment partially.');
  await assert.rejects(RedisLease.acquire(redis, 'other-job', 60_000), RedisUnavailable);
  await assert.rejects(lease.setJson('published', { generation: 'must-not-publish' }, 60), RedisUnavailable);
  assert.deepEqual(JSON.parse((await raw.get(redis.key('published')))!), { generation: 'before-pressure' });
  assert.equal(await raw.get(lease.key), lease.token);
  assert.equal(await raw.exists(redis.key('lease:other-job')), 0);

  await raw.sendCommand(['DEL', ...pressureKeys]);
  pressureKeys.length = 0;
  assert.equal((await rateLimit(redis, secret, clientIp, 10)).limited, false);
  assert.equal(await raw.get(rateKey), '2');
  assert.equal(await lease.renew(), true);
  await lease.setJson('published', { generation: 'after-recovery' }, 60);
  assert.deepEqual(await redis.json('published'), { generation: 'after-recovery' });
  assert.equal(await raw.get(lease.key), lease.token);
  const evicted = /^evicted_keys:(\d+)\r?$/m.exec(await raw.info('stats'));
  assert.equal(evicted?.[1], '0', 'Redis must reject writes instead of evicting keys.');
});
