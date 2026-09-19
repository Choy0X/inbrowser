import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedRedis, RedisLease, RedisUnavailable } from '../src/redis.ts';
import { CatalogRepository } from '../src/catalog/repository.ts';
import { normalizeCandidate, scoreProxy, validateQuery, type CatalogProxy } from '../src/catalog/model.ts';

const redisUrl=process.env.TEST_REDIS_URL??'redis://127.0.0.1:16380';
async function fixture(){
  const redis=new SharedRedis({url:redisUrl,keyPrefix:`repository-test:${randomUUID()}:`,commandTimeoutMs:10_000});redis.start();
  for(let i=0;i<100&&!redis.ready;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(redis.ready,'The dedicated real Redis fixture must be running');
  const stateDir=await mkdtemp(join(tmpdir(),'catalog-repository-'));
  const repository=new CatalogRepository(redis,60,stateDir);
  const lease=await RedisLease.acquire(redis,'catalog-job');assert.ok(lease);
  return {redis,repository,lease,stateDir,async close(){
    await lease.release();let cursor='0';do{const [next,keys]=await redis.command<[string,string[]]>('SCAN',cursor,'MATCH',redis.prefix+'*','COUNT','500');cursor=next;if(keys.length)await redis.command('UNLINK',...keys);}while(cursor!=='0');
    await redis.close();await rm(stateDir,{recursive:true,force:true});
  }};
}
function proxy(index:number,patch:Partial<CatalogProxy>={}):CatalogProxy{
  const now=Date.now();const p={...normalizeCandidate(`proxy${index}.example.com:${1000+index%60000}`,'http','fixture')!,latencyMs:100+index,successes:10,checks:10,lastCheckedAt:now,lastSuccessAt:now,country:'US',exitIp:`8.8.${Math.floor(index/250)%250}.${index%250+1}`,...patch};
  p.score=scoreProxy(p,now,7_200_000);return p;
}

test('real Redis repository: indexed updates, exact filters, scores, pagination, expiry and lease fencing',async()=>{
  const f=await fixture();try{
    const records=Array.from({length:8},(_,i)=>proxy(i));
    const generation=await f.repository.createGeneration(records,f.lease);
    assert.equal(await f.repository.manifest(),null,'Creation does not activate partial builds');
    await f.repository.activate(generation,f.lease);
    const first=await f.repository.page(validateQuery({sort:'latency',limit:3}));
    assert.equal(first.total,8);assert.deepEqual(first.items.map(p=>p.id),records.slice(0,3).map(p=>p.id));assert.ok(first.nextCursor);
    const second=await f.repository.page(validateQuery({sort:'latency',limit:3,cursor:first.nextCursor}));
    assert.deepEqual(second.items.map(p=>p.id),records.slice(3,6).map(p=>p.id));
    await assert.rejects(f.repository.page(validateQuery({sort:'score',limit:3,cursor:first.nextCursor})),/Invalid cursor/);
    for(const q of ['proxy0','1000','8.8.0.1','pr','0']){
      const page=await f.repository.page(validateQuery({q}));assert.ok(page.items.some(p=>p.id===records[0].id),q);
      assert.equal(page.total,page.items.length);
    }
    assert.equal((await f.repository.page(validateQuery({q:'fixture'}))).total,0,'Source labels are not searchable');
    const changed={...records[0],country:'DE',exitIp:'9.9.9.9',protocol:'socks5' as const,latencyMs:1};
    await f.repository.updateGeneration(generation,[changed],f.lease);
    assert.equal((await f.repository.page(validateQuery({protocol:'http',country:'US'}))).total,7);
    assert.equal((await f.repository.page(validateQuery({protocol:'socks5',country:'DE',q:'9.9.9.9'}))).total,1);
    assert.equal((await f.repository.page(validateQuery({q:'8.8.0.1'}))).items.length,0,'Cached queries never show obsolete exit matches');
    const failed={...changed,lastCheckedAt:changed.lastSuccessAt+1};
    await f.repository.updateGeneration(generation,[failed],f.lease);
    assert.equal((await f.repository.resolve([failed.id])).items.length,0);
    assert.equal((await f.repository.page(validateQuery({}))).total,7);
    const recommended=await f.repository.recommend(validateQuery({}),3,[records[1].id]);
    assert.equal(recommended.length,3);assert.ok(recommended.every(p=>p.id!==records[1].id));
    const all=await f.repository.all();assert.equal(all.length,8,'Failed records remain available to the next checking cycle');
    const oldCursor=JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString());
    await f.redis.command('DEL',f.redis.key('catalog:query:'+oldCursor.k+':meta'));
    await assert.rejects(f.repository.page(validateQuery({sort:'latency',limit:3,cursor:first.nextCursor})),/expired/);
    const oldPage=await f.repository.page(validateQuery({sort:'latency',limit:2}));
    const newer=await f.repository.createGeneration([records[2]],f.lease);await f.repository.activate(newer,f.lease);
    const oldNext=await f.repository.page(validateQuery({sort:'latency',limit:2,cursor:oldPage.nextCursor!}));
    assert.deepEqual(oldNext.items.map(p=>p.id),[records[3].id,records[4].id],'An old cursor remains pinned to its generation');
    const oldTtl=await f.redis.command<number>('TTL',f.redis.key(`catalog:g:${generation}:records`));assert.ok(oldTtl>0&&oldTtl<=300);
    let cursor='0';do{const [next,keys]=await f.redis.command<[string,string[]]>('SCAN',cursor,'MATCH',f.redis.prefix+'catalog:*','COUNT','100');cursor=next;for(const key of keys)assert.ok(await f.redis.command<number>('TTL',key)>0,key);}while(cursor!=='0');
    await f.redis.command('SET',f.lease.key,'replacement-owner','PX','60000');
    await assert.rejects(f.repository.updateGeneration(newer,[records[3]],f.lease),RedisUnavailable);
    await assert.rejects(f.repository.activate(generation,f.lease),RedisUnavailable);
    assert.equal((await f.repository.manifest())?.generation,newer);
  }finally{await f.close();}
});

test('real Redis snapshot round trip, stale writer exclusion, and diverse recommendation ordering',async()=>{
  const f=await fixture();try{
    const records=[proxy(20,{exitIp:'1.1.1.1',latencyMs:10}),proxy(21,{exitIp:'1.1.1.1',latencyMs:20}),proxy(22,{exitIp:'2.2.2.2',latencyMs:50})];
    await f.repository.publish(records,f.lease);
    const best=await f.repository.recommend(validateQuery({}),2,[]);assert.equal(new Set(best.map(p=>p.exitIp)).size,2);
    await f.repository.saveSnapshot(records,f.lease);
    const saved=await readFile(join(f.stateDir,'catalog.json'),'utf8');assert.equal(JSON.parse(saved.split('\n')[0]).version,2);
    await f.redis.command('DEL',f.redis.key('catalog:current'));await f.repository.restore(f.lease);
    assert.equal((await f.repository.page(validateQuery({}))).total,3);
    const restored=(await f.repository.page(validateQuery({sort:'score'}))).items;
    assert.deepEqual(restored.map(p=>p.id),[...records].sort((a,b)=>scoreProxy(b,Date.now(),7_200_000)-scoreProxy(a,Date.now(),7_200_000)).map(p=>p.id));
    await f.redis.command('SET',f.lease.key,'replacement-owner','PX','60000');
    await assert.rejects(f.repository.saveSnapshot([],f.lease),RedisUnavailable);
    assert.equal(await readFile(join(f.stateDir,'catalog.json'),'utf8'),saved);
  }finally{await f.close();}
});

for(const size of [10_000,100_000])test(`real Redis ${size} catalog fixture serves search, recommendations and pagination`, {skip:process.env.CATALOG_BENCHMARK!=='1',timeout:180_000},async()=>{
  const f=await fixture();try{
    const records=Array.from({length:size},(_,i)=>proxy(i,{country:i%2?'US':'DE'}));
    const start=performance.now();await f.repository.publish(records,f.lease);const publishMs=performance.now()-start;
    const pageQuery=validateQuery({protocol:'http',country:'US',sort:'latency',limit:50});
    const pageStart=performance.now();const page=await f.repository.page(pageQuery);const pageMs=performance.now()-pageStart;
    assert.equal(page.total,size/2);assert.equal(page.items.length,50);assert.equal(page.items[0].id,records[1].id);assert.ok(page.nextCursor);
    const nextStart=performance.now();const next=await f.repository.page({...pageQuery,cursor:page.nextCursor!});const nextPageMs=performance.now()-nextStart;
    assert.equal(next.items.length,50);assert.equal(next.items[0].id,records[101].id);
    const firstIds=new Set(page.items.map(p=>p.id));assert.ok(next.items.every(p=>!firstIds.has(p.id)));
    const searchStart=performance.now();const search=await f.repository.page(validateQuery({q:'proxy99',sort:'score',limit:50}));const searchMs=performance.now()-searchStart;
    assert.equal(search.total,records.filter(p=>p.host.includes('proxy99')).length);assert.equal(search.items.length,50);assert.ok(search.items.every(p=>p.host.includes('proxy99')));
    const recommendStart=performance.now();const top=await f.repository.recommend(validateQuery({country:'US'}),10,[records[1].id]);const recommendMs=performance.now()-recommendStart;
    assert.equal(top.length,10);assert.equal(new Set(top.map(p=>p.exitIp)).size,10);assert.ok(top.every(p=>p.country==='US'&&p.id!==records[1].id));
    assert.ok(top.every((p,i)=>i===0||top[i-1].score>=p.score));
    console.log(JSON.stringify({records:size,publishMs:Math.round(publishMs),pageMs:Math.round(pageMs),searchMs:Math.round(searchMs),recommendMs:Math.round(recommendMs),nextPageMs:Math.round(nextPageMs),heapMiB:Math.round(process.memoryUsage().heapUsed/1024/1024)}));
  }finally{await f.close();}
});

test('real Redis exact substring filtering removes trigram false positives and rejects stale/future observations',async()=>{
  const f=await fixture();try{
    const now=Date.now(),old=now-8_000_000,future=now+60_000;
    const collision={...normalizeCandidate('abcbcd.example.com:8080','http','fixture')!,latencyMs:100,successes:1,checks:1,lastCheckedAt:now,lastSuccessAt:now};
    await f.repository.publish([collision,proxy(100,{lastCheckedAt:old,lastSuccessAt:old}),proxy(101,{lastCheckedAt:future,lastSuccessAt:future})],f.lease);
    assert.equal((await f.repository.page(validateQuery({q:'abcd'}))).total,0);
    assert.equal((await f.repository.page(validateQuery({q:'abcbcd'}))).total,1);
    assert.equal((await f.repository.page(validateQuery({}))).total,1);
  }finally{await f.close();}
});

test('real Redis caps query amplification before copies and prevents evicted builders from returning',async()=>{
  const f=await fixture();const realNow=Date.now;try{
    const records=Array.from({length:500},(_,i)=>proxy(i));
    const generation=await f.repository.createGeneration(records,f.lease);await f.repository.activate(generation,f.lease);
    // Keep this test inside one cache bucket, including on a real wall-clock boundary.
    const bucketStart=(Math.floor(realNow()/30_000)+1)*30_000+1000;let clockStep=0;
    Date.now=()=>bucketStart+clockStep++;
    const initial=await f.repository.page(validateQuery({limit:1}));assert.ok(initial.nextCursor);
    for(let limit=1;limit<=100;limit++)await f.repository.page(validateQuery({limit}));
    assert.equal(await f.redis.command<number>('ZCARD',f.redis.key('catalog:queries')),1,'Page sizes share membership snapshots');
    await f.repository.updateGeneration(generation,[records[0]],f.lease);
    await f.repository.page(validateQuery({limit:50}));
    assert.equal(await f.redis.command<number>('ZCARD',f.redis.key('catalog:queries')),1,'Progress updates do not allocate new snapshots');
    const resized=await f.repository.page(validateQuery({limit:4,cursor:initial.nextCursor!}));assert.equal(resized.items.length,4,'A cursor allows changing page size');
    const terms=['p','r','o','x','y','pr','ro','ox','xy','pro','rox','oxy','prox','roxy','proxy','example','com','http','8.','8.8'];
    const sorts=['score','latency','freshness'] as const;
    for(let i=0;i<120;i++){
      const page=await f.repository.page(validateQuery({q:terms[i%terms.length],sort:sorts[i%3],protocol:i>=60?'http':'',limit:i%100+1}));
      assert.equal(page.total,500);
      assert.ok(await f.redis.command<number>('ZCARD',f.redis.key('catalog:queries'))<=8);
    }
    await assert.rejects(f.repository.page(validateQuery({limit:1,cursor:initial.nextCursor!})),/expired/,'Eviction gives a recoverable cursor error');
    const overlapping=await Promise.allSettled(Array.from({length:24},(_,i)=>f.repository.page(validateQuery({q:terms[i%terms.length],sort:sorts[i%3],country:'US',limit:3}))));
    assert.ok(overlapping.some(result=>result.status==='fulfilled'));
    for(const result of overlapping)if(result.status==='rejected')assert.match(String(result.reason),/expired/);
    const queryKeys:string[]=[];let cursor='0';
    do{const [next,keys]=await f.redis.command<[string,string[]]>('SCAN',cursor,'MATCH',f.redis.prefix+'catalog:query:*','COUNT','100');cursor=next;for(const key of keys){assert.ok(await f.redis.command<number>('PTTL',key)>0);if(/:query:[a-f0-9]{24}$/.test(key))queryKeys.push(key);}}while(cursor!=='0');
    assert.ok(queryKeys.length<=8,`Only eight result sets may exist, found ${queryKeys.length}`);
    let bytes=0;for(const key of queryKeys)bytes+=await f.redis.command<number>('MEMORY','USAGE',key);
    assert.ok(bytes<1_000_000,`500-record query copies stay below 1MB, got ${bytes}`);
    assert.ok(await f.redis.command<number>('PTTL',f.redis.key('catalog:queries'))>0);
  }finally{Date.now=realNow;await f.close();}
});
