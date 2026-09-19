import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '../src/config.ts';
import { SharedRedis, RedisLease } from '../src/redis.ts';
import { CatalogRepository } from '../src/catalog/repository.ts';
import { nextBoundary, normalizeCandidate } from '../src/catalog/model.ts';
import { runCatalogJob, startCatalogScheduler } from '../src/catalog/scheduler.ts';

test('first installation discovers once across processes, then restarts and Redis loss keep the schedule', async t => {
  const state = await mkdtemp(join(tmpdir(), 'catalog-initial-'));
  const config = loadConfig({REDIS_URL:process.env.TEST_REDIS_URL || 'redis://127.0.0.1:16380',REDIS_KEY_PREFIX:`test:initial:${randomUUID()}:`,RELAY_SECRET:'initial-discovery-test-secret-32-characters',FREE_PROXY_STATE_DIR:state});
  const redis = new SharedRedis(config.redis); redis.start(); assert.ok(await redis.waitReady());
  const repo = new CatalogRepository(redis,60,state);
  const stops:(()=>void)[]=[];
  const clear = async () => {
    let cursor='0'; do { const page=await redis.command<[string,string[]]>('SCAN',cursor,'MATCH',redis.key('*'),'COUNT','100');cursor=page[0];if(page[1].length)await redis.command('DEL',...page[1]); } while(cursor!=='0');
  };
  let finish:()=>void=()=>{};
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  t.after(async()=>{finish();stops.forEach(stop=>stop());await delay(50);await clear();await redis.close();await rm(state,{recursive:true,force:true});});
  let collections=0;
  const run:typeof runCatalogJob=(c,r,s,_io,lease)=>runCatalogJob(c,r,s,{collect:async()=>{collections++;await pending;return [];},check:async()=>null},lease);
  stops.push(startCatalogScheduler(config,repo,run),startCatalogScheduler(config,repo,run));
  for(let i=0;i<100&&collections===0;i++)await delay(10);
  assert.equal(collections,1,'The first run starts without waiting for the hourly boundary');
  assert.equal((await repo.status()).running,true);
  finish();
  for(let i=0;i<100&&(await repo.status()).running;i++)await delay(10);
  assert.equal((await repo.status()).running,false);
  assert.ok((await repo.status()).lastCompletedAt);
  stops.forEach(stop=>stop());
  // Losing all ephemeral keys must not turn an empty successful result into a
  // brand-new installation. Only this fixture namespace is removed.
  await clear();
  stops.push(startCatalogScheduler(config,repo,run));
  await delay(100);
  assert.equal(collections,1,'The durable empty snapshot suppresses another startup run');
});

test('an interrupted initial discovery is attempted once and retried only on the scheduled boundary', async t => {
  const state=await mkdtemp(join(tmpdir(),'catalog-initial-failed-'));
  const config=loadConfig({REDIS_URL:process.env.TEST_REDIS_URL || 'redis://127.0.0.1:16380',REDIS_KEY_PREFIX:`test:initial-failed:${randomUUID()}:`,RELAY_SECRET:'initial-failure-test-secret-32-characters',FREE_PROXY_STATE_DIR:state});
  const redis=new SharedRedis(config.redis);redis.start();assert.ok(await redis.waitReady());
  const repo=new CatalogRepository(redis,60,state);const stops:(()=>void)[]=[];
  t.after(async()=>{stops.forEach(stop=>stop());await delay(30);let cursor='0';do{const page=await redis.command<[string,string[]]>('SCAN',cursor,'MATCH',redis.key('*'),'COUNT','100');cursor=page[0];if(page[1].length)await redis.command('DEL',...page[1]);}while(cursor!=='0');await redis.close();await rm(state,{recursive:true,force:true});});
  let attempts=0;
  const run:typeof runCatalogJob=(c,r,s,_io,lease)=>runCatalogJob(c,r,s,{collect:async()=>{attempts++;throw new Error('fixture unavailable');},check:async()=>null},lease);
  stops.push(startCatalogScheduler(config,repo,run));
  for(let i=0;i<100&&attempts===0;i++)await delay(10);
  assert.equal(attempts,1);
  for(let i=0;i<100&&(await repo.status()).running;i++)await delay(10);
  stops.forEach(stop=>stop());stops.push(startCatalogScheduler(config,repo,run));
  await delay(100);assert.equal(attempts,1);
  // A normal scheduler invocation still performs the next attempt.
  await run(config,repo,new AbortController().signal);
  assert.equal(attempts,2);
});

test('scheduler waits for configured boundary, skips overlap, and never catches up on reconnect', async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:1000});
  const config=loadConfig({FREE_PROXY_INTERVAL_MINUTES:'60'});
  const redis={ready:true};
  const repo={redis,manifest:async()=>({generation:'existing'})} as unknown as CatalogRepository;
  let runs=0,finish:()=>void=()=>{};
  const stop=startCatalogScheduler(config,repo,async()=>{runs++;await new Promise<void>(r=>{finish=r;});});t.after(stop);
  await Promise.resolve();await Promise.resolve();
  assert.equal(runs,0);
  t.mock.timers.tick(3_598_000);assert.equal(runs,0);await Promise.resolve();await Promise.resolve();
  t.mock.timers.tick(1000);assert.equal(runs,1);
  t.mock.timers.tick(3_600_000);assert.equal(runs,1);
  finish();await Promise.resolve();await Promise.resolve();await Promise.resolve();
  redis.ready=false;t.mock.timers.tick(3_600_000);assert.equal(runs,1);
  redis.ready=true;t.mock.timers.tick(15_000);assert.equal(runs,1);
  stop();t.mock.timers.tick(3_600_000);assert.equal(runs,1);
});

test('real scheduled pipeline deduplicates checks, stores fresh successes, and honors a competing lease', async t=>{
  const state=await mkdtemp(join(tmpdir(),'inbrowser-catalog-'));
  const config=loadConfig({REDIS_URL:process.env.TEST_REDIS_URL||'redis://127.0.0.1:16380',REDIS_KEY_PREFIX:`test:scheduler:${randomUUID()}:`,RELAY_SECRET:'test-scheduler-secret-32-characters-long',FREE_PROXY_STATE_DIR:state,FREE_PROXY_STARTS_PER_SECOND:'1000'});
  const redis=new SharedRedis(config.redis);redis.start();assert.ok(await redis.waitReady());
  const repo=new CatalogRepository(redis,60,state);const signal=new AbortController().signal;
  t.after(async()=>{const keys:string[]=[];let cursor='0';do{const page=await redis.command<[string,string[]]>('SCAN',cursor,'MATCH',redis.key('*'),'COUNT','1000');cursor=page[0];keys.push(...page[1]);}while(cursor!=='0');if(keys.length)await redis.command('DEL',...keys);await redis.close();await rm(state,{recursive:true,force:true});});
  const a=normalizeCandidate('8.8.8.8:80','http','fixture')!,b=normalizeCandidate('1.1.1.1:80','http','fixture')!;
  let collections=0,checks=0;
  const io={collect:async()=>{collections++;return[a,a,b];},check:async(p:typeof a)=>{checks++;return p.id===a.id?{exitIp:'9.9.9.9',country:'US',latencyMs:25}:null;}};
  const other=await RedisLease.acquire(redis,'catalog-job');assert.ok(other);
  await runCatalogJob(config,repo,signal,io);assert.equal(collections,0);await other.release();
  await runCatalogJob(config,repo,signal,io);assert.equal(collections,1);assert.equal(checks,2);
  const result=await repo.resolve([a.id,b.id]);assert.deepEqual(result.items.map(p=>p.id),[a.id]);assert.deepEqual(result.unavailableIds,[b.id]);
  assert.equal((await repo.status()).running,false);assert.ok((await repo.status()).lastCompletedAt);
  const next=await RedisLease.acquire(redis,'catalog-job');assert.ok(next);await next.release();
});

test('restarting with a changed interval uses the new boundary without an immediate run', async t => {
  // Start at 00:20:01. A one-hour schedule would next run at 01:00:00.
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 20 * 60_000 + 1000 });
  const repository = { redis: { ready: true }, manifest: async () => ({ generation: 'persisted' }) } as unknown as CatalogRepository;
  const starts: number[] = [];
  const run = async () => { starts.push(Date.now()); };
  const oldStop = startCatalogScheduler(loadConfig({ FREE_PROXY_INTERVAL_MINUTES: '60' }), repository, run);
  t.after(oldStop);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(9 * 60_000 + 58_000);
  assert.deepEqual(starts, []);
  oldStop();

  // Restart at 00:29:59 with a 30-minute interval. Existing persisted data must
  // not trigger a startup job or keep the former one-hour deadline.
  const newStop = startCatalogScheduler(loadConfig({ FREE_PROXY_INTERVAL_MINUTES: '30' }), repository, run);
  t.after(newStop);
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(starts, []);
  t.mock.timers.tick(1000);
  assert.deepEqual(starts, [30 * 60_000]);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(30 * 60_000);
  assert.deepEqual(starts, [30 * 60_000, 60 * 60_000]);
});

test('a full catalog of stale successes makes room for newly discovered proxies', async t => {
  const state = await mkdtemp(join(tmpdir(), 'inbrowser-catalog-rotation-'));
  const config = loadConfig({
    REDIS_URL: process.env.TEST_REDIS_URL || 'redis://127.0.0.1:16380',
    REDIS_KEY_PREFIX: `test:scheduler:rotation:${randomUUID()}:`,
    RELAY_SECRET: 'test-scheduler-secret-32-characters-long',
    FREE_PROXY_STATE_DIR: state, FREE_PROXY_MAX_CANDIDATES: '4',
    FREE_PROXY_INTERVAL_MINUTES: '30', FREE_PROXY_STARTS_PER_SECOND: '1000',
  });
  const redis = new SharedRedis(config.redis);
  // Register cleanup before connecting, so a failed assertion cannot retain a client.
  t.after(async () => {
    try {
      if (redis.ready) {
        const keys: string[] = []; let cursor = '0';
        do {
          const page = await redis.command<[string, string[]]>('SCAN', cursor, 'MATCH', redis.key('*'), 'COUNT', '1000');
          cursor = page[0]; keys.push(...page[1]);
        } while (cursor !== '0');
        if (keys.length) await redis.command('DEL', ...keys);
      }
    } finally { await redis.close(); await rm(state, { recursive: true, force: true }); }
  });
  redis.start(); assert.ok(await redis.waitReady());
  const repository = new CatalogRepository(redis, 30, state, 4);
  const staleAt = Date.now() - repository.maxAge - 60_000;
  const previous = Array.from({ length: 4 }, (_, index) => ({
    ...normalizeCandidate(`8.8.4.${index + 1}:8080`, 'http', 'previous-feed')!,
    lastSuccessAt: staleAt, lastCheckedAt: staleAt, checks: 100, successes: 100,
    score: 1, latencyMs: 5, exitIp: `9.9.9.${index + 1}`,
  }));
  const discovered = ['1.1.1.1:8080', '1.0.0.1:8080'].map(value => normalizeCandidate(value, 'http', 'new-feed')!);
  const seedLease = await RedisLease.acquire(redis, 'catalog-job'); assert.ok(seedLease);
  try {
    const generation = await repository.createGeneration(previous, seedLease);
    await repository.activate(generation, seedLease);
    // Simulate persisted state from a previous deployment with a different
    // interval. Reads must report the current configuration's boundary.
    await seedLease.setJson('catalog:status', { running: false, lastCompletedAt: staleAt, nextRunAt: Date.now() + 24 * 60 * 60_000 }, 600);
  } finally { await seedLease.release(); }
  assert.equal((await repository.all()).length, config.freeProxyCatalog.maxCandidates);
  assert.equal((await repository.status()).nextRunAt, nextBoundary(Date.now(), 30));
  assert.equal((await repository.resolve(previous.map(proxy => proxy.id))).items.length, 0);

  const checked: string[] = [];
  await runCatalogJob(config, repository, new AbortController().signal, {
    collect: async (_secret, _signal, maximum, retained) => {
      assert.equal(maximum, 4); assert.equal(retained.length, 4);
      // Returning the old feeds first reproduces the starvation condition in
      // an append-and-truncate merge, even when stale entries scored highly.
      return [...previous, ...discovered];
    },
    check: async candidate => {
      checked.push(candidate.id);
      return discovered.some(proxy => proxy.id === candidate.id)
        ? { exitIp: candidate.host, country: 'US', latencyMs: 15 }
        : null;
    },
  });
  assert.equal(checked.length, 4);
  assert.equal(new Set(checked).size, 4);
  for (const candidate of discovered) assert.ok(checked.includes(candidate.id), 'A new candidate must be checked despite stale successes filling the prior catalog.');
  const stored = await repository.all(); assert.equal(stored.length, 4);
  const resolved = await repository.resolve(discovered.map(proxy => proxy.id));
  assert.deepEqual(new Set(resolved.items.map(proxy => proxy.id)), new Set(discovered.map(proxy => proxy.id)));
  assert.deepEqual(resolved.unavailableIds, []);
  assert.equal((await repository.resolve(previous.map(proxy => proxy.id))).items.length, 0);
  assert.equal((await repository.status()).running, false);
  assert.equal((await repository.status()).lastError, undefined);
});
