import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { SharedRedis, RedisLease, RedisUnavailable } from '../redis.ts';
import { eligible, matches, normalizeCandidate, scoreProxy, trigrams, type CatalogProxy, type CatalogQuery, type CatalogStatus, CatalogInputError, nextBoundary } from './model.ts';

export interface CatalogReader {
  page(query: CatalogQuery): Promise<{items:CatalogProxy[];nextCursor:string|null;total:number;status:CatalogStatus;generatedAt:number}>;
  recommend(query:CatalogQuery,count:number,excludeIds:string[]):Promise<CatalogProxy[]>;
  resolve(ids:string[]):Promise<{items:CatalogProxy[];unavailableIds:string[]}>;
}
interface Manifest { generation:string; generatedAt:number }
interface QuerySnapshot extends Manifest { fingerprint:string; total:number }
const hash=(text:string)=>createHash('sha256').update(text).digest('hex').slice(0,24);
const BATCH=100;
const QUERY_TTL=120;
const MAX_SNAPSHOT_LINE=32_768;

// One bounded batch is atomic, including ownership, old membership removal, and
// first-write TTLs. The old record provides its index keys without a second copy.
const UPSERT=`
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('HGET',KEYS[2],'owner')~=ARGV[1] then return 0 end
local base=ARGV[2]; local ttl=tonumber(ARGV[3]); local now=tonumber(ARGV[4]); local age=tonumber(ARGV[5]); local cap=tonumber(ARGV[6]);
local touched={}
local function register(key) if not touched[key] then touched[key]=true;redis.call('SADD',base..'keys',key) end end
local function memberships(p,add)
  local command=add and 'SADD' or 'SREM'
  local function change(suffix)
    local key=base..suffix;redis.call(command,key,p.id);if add then redis.call('EXPIRE',key,ttl);register(key) end
  end
  change('protocol:'..p.protocol)
  if p.country and p.country~='' then change('country:'..p.country) end
  local text=string.lower(p.host..' '..p.port..' '..p.protocol..' '..(p.exitIp or '')..' '..(p.country or ''))
  local seen={}
  for i=1,#text-2 do local token=string.sub(text,i,i+2);if not seen[token] then seen[token]=true;change('text:'..token) end end
end
local records=cjson.decode(ARGV[7]);local count=redis.call('HLEN',KEYS[3])
for _,p in ipairs(records) do
  local old=redis.call('HGET',KEYS[3],p.id)
  if old or count<cap then
    if old then memberships(cjson.decode(old),false) else count=count+1 end
    redis.call('HSET',KEYS[3],p.id,cjson.encode(p));redis.call('EXPIRE',KEYS[3],ttl)
    redis.call('ZREM',KEYS[4],p.id);redis.call('ZREM',KEYS[5],p.id);redis.call('ZREM',KEYS[6],p.id)
    if p.lastSuccessAt>0 and p.lastSuccessAt<=now and p.lastSuccessAt==p.lastCheckedAt and now-p.lastSuccessAt<age then
      local score=.6*((p.successes+1)/(p.checks+2))+.25*(1000/(1000+math.max(1,p.latencyMs)))+.15*p.lastSuccessAt/age
      redis.call('ZADD',KEYS[4],score,p.id);redis.call('ZADD',KEYS[5],-p.latencyMs,p.id);redis.call('ZADD',KEYS[6],p.lastSuccessAt,p.id)
      redis.call('EXPIRE',KEYS[4],ttl);redis.call('EXPIRE',KEYS[5],ttl);redis.call('EXPIRE',KEYS[6],ttl)
      memberships(p,true)
    end
  end
end
for i=2,6 do register(KEYS[i]) end;register(base..'keys');redis.call('EXPIRE',base..'keys',ttl)
redis.call('HINCRBY',KEYS[2],'revision',1);redis.call('EXPIRE',KEYS[2],ttl);return 1`;

/** Stored-data reads only: the repository cannot invoke a checker or source. */
export class CatalogRepository implements CatalogReader {
  readonly redis:SharedRedis;
  readonly intervalMinutes:number;
  readonly stateDir:string;
  readonly maxCandidates:number;
  constructor(redis:SharedRedis,intervalMinutes:number,stateDir:string,maxCandidates=100_000) {
    this.redis=redis;this.intervalMinutes=intervalMinutes;this.stateDir=stateDir;this.maxCandidates=maxCandidates;
  }
  get maxAge():number{return this.intervalMinutes*120_000;}
  private get ttl():number{return Math.ceil(this.maxAge/1000)+300;}
  private base(generation:string):string{return `catalog:g:${generation}:`;}
  async manifest():Promise<Manifest|null>{return this.redis.json<Manifest>('catalog:current');}
  async status():Promise<CatalogStatus>{
    const status=await this.redis.json<CatalogStatus>('catalog:status');
    const running=!!await this.redis.command<number>('EXISTS',this.redis.key('lease:catalog-job'));
    return {...status,lastCompletedAt:status?.lastCompletedAt??null,running,nextRunAt:nextBoundary(Date.now(),this.intervalMinutes)};
  }
  async records(generation:string,ids:string[]):Promise<CatalogProxy[]>{
    const result:CatalogProxy[]=[];
    for(let start=0;start<ids.length;start+=BATCH){
      const values=await this.redis.command<(string|null)[]>('HMGET',this.redis.key(this.base(generation)+'records'),...ids.slice(start,start+BATCH));
      for(const value of values)if(value)result.push(JSON.parse(value) as CatalogProxy);
    }
    return result;
  }
  async resolve(ids:string[]):Promise<{items:CatalogProxy[];unavailableIds:string[]}>{
    if(ids.length>100)throw new CatalogInputError('Supply up to 100 existing catalog IDs only.');
    const manifest=await this.manifest(),now=Date.now();
    const items=manifest?(await this.records(manifest.generation,[...new Set(ids)])).filter(p=>eligible(p,now,this.maxAge)).map(p=>({...p,score:scoreProxy(p,now,this.maxAge)})):[];
    const found=new Set(items.map(p=>p.id));return {items,unavailableIds:ids.filter(id=>!found.has(id))};
  }
  private fingerprint(query:CatalogQuery):string{return hash(JSON.stringify([query.q,query.protocol,query.country,query.sort]));}
  /** Share immutable memberships while bounding materialized snapshots per namespace. */
  private async querySnapshot(query:CatalogQuery,manifest:Manifest):Promise<{key:string;snapshot:QuerySnapshot}>{
    const base=this.redis.key(this.base(manifest.generation));
    const cache=this.redis.key('catalog:query-cache:'+hash(JSON.stringify([manifest.generation,this.fingerprint(query),Math.floor(Date.now()/30_000)])));
    const cached=await this.redis.command<string|null>('GET',cache);
    if(cached){
      const value=await this.redis.command<string|null>('GET',cached+':meta');
      if(value){const snapshot=JSON.parse(value) as QuerySnapshot;if(snapshot.total===0||await this.redis.command<number>('EXISTS',cached))return {key:cached,snapshot};}
    }
    const key=this.redis.key('catalog:query:'+hash(randomUUID()));
    const fresh=key+':fresh';
    const keys=[base+query.sort];
    if(query.protocol)keys.push(base+'protocol:'+query.protocol);
    if(query.country)keys.push(base+'country:'+query.country);
    for(const token of trigrams(query.q))keys.push(base+'text:'+token);
    // WEIGHTS retains the exact ranking of the sorted index. Set membership
    // contributes zero, and freshness excludes expired entries before counting.
    const admitted=await this.redis.command<string>('EVAL',`
      local cached=redis.call('GET',KEYS[5]);if cached then local meta=redis.call('GET',cached..':meta');if meta and (redis.call('EXISTS',cached)==1 or cjson.decode(meta).total==0) then return cached end end
      local function evict(old)
        local pointer=redis.call('GET',old..':cache');if pointer and redis.call('GET',pointer)==old then redis.call('DEL',pointer) end
        redis.call('DEL',old,old..':meta',old..':pending',old..':cache',old..':fresh');redis.call('ZREM',KEYS[1],old)
      end
      local expired=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',tonumber(ARGV[3])-tonumber(ARGV[2])*1000,'LIMIT',0,8)
      for _,old in ipairs(expired) do evict(old) end
      while redis.call('ZCARD',KEYS[1])>=8 do local oldest=redis.call('ZRANGE',KEYS[1],0,0);evict(oldest[1]) end
      redis.call('ZADD',KEYS[1],ARGV[3],KEYS[2]);redis.call('EXPIRE',KEYS[1],ARGV[2])
      redis.call('SET',KEYS[2]..':pending','1','EX',ARGV[2]);redis.call('SET',KEYS[2]..':cache',KEYS[5],'EX',ARGV[2])
      redis.call('ZRANGESTORE',KEYS[3],KEYS[4],ARGV[1],'+inf','BYSCORE');redis.call('EXPIRE',KEYS[3],ARGV[2]);
      local args={KEYS[2],#KEYS-4};for i=6,#KEYS do table.insert(args,KEYS[i]) end;table.insert(args,KEYS[3]);
      table.insert(args,'WEIGHTS');table.insert(args,1);for i=2,#KEYS-4 do table.insert(args,0) end;
      redis.call('ZINTERSTORE',unpack(args));redis.call('EXPIRE',KEYS[2],ARGV[2]);redis.call('DEL',KEYS[3]);return KEYS[2]`,
      String(keys.length+5),this.redis.key('catalog:queries'),key,fresh,base+'freshness',cache,...keys,'('+String(Date.now()-this.maxAge),String(QUERY_TTL),String(Date.now()));
    if(admitted!==key){
      const value=await this.redis.command<string|null>('GET',admitted+':meta');
      if(!value)throw new CatalogInputError('This page expired. Start from the first page.');
      return {key:admitted,snapshot:JSON.parse(value) as QuerySnapshot};
    }
    // Trigrams are a candidate index, not exact substring proof. Validate in
    // bounded batches (also handles one/two-character searches), then remove
    // false positives together after each read without shifting our offset.
    if(query.q){
      let offset=0;
      for(;;){
        const ids=await this.redis.command<string[]>('ZRANGE',key,String(offset),String(offset+BATCH-1));
        if(!ids.length)break;
        const values=await this.records(manifest.generation,ids);
        const matching=new Set(values.filter(p=>matches(p,query)).map(p=>p.id));
        const rejected=ids.filter(id=>!matching.has(id));
        if(rejected.length)await this.redis.command('ZREM',key,...rejected);
        offset+=ids.length-rejected.length;
        if(offset>this.maxCandidates)throw new RedisUnavailable();
      }
    }
    const total=await this.redis.command<number>('ZCARD',key);
    const snapshot:QuerySnapshot={...manifest,fingerprint:this.fingerprint(query),total};
    // An evicted or expired builder cannot resurrect its result or metadata.
    // All keys retain the original reservation deadline, even after filtering.
    const finalized=await this.redis.command<number>('EVAL',`local ttl=redis.call('PTTL',KEYS[2]..':pending');if ttl<=0 or not redis.call('ZSCORE',KEYS[1],KEYS[2]) then return 0 end;redis.call('SET',KEYS[2]..':meta',ARGV[1],'PX',ttl);redis.call('SET',KEYS[3],KEYS[2],'PX',ttl);redis.call('DEL',KEYS[2]..':pending');return 1`,'3',this.redis.key('catalog:queries'),key,cache,JSON.stringify(snapshot));
    if(!finalized)throw new CatalogInputError('This page expired. Start from the first page.');
    return {key,snapshot};
  }
  async page(query:CatalogQuery){
    const current=await this.manifest(),status=await this.status();
    if(!current)return {items:[],nextCursor:null,total:0,status,generatedAt:0};
    let key:string,snapshot:QuerySnapshot,offset=0;
    if(query.cursor){
      let cursor:{k:string;o:number};
      try{cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString());}catch{throw new CatalogInputError('Invalid cursor.');}
      if(!cursor||!/^[a-f0-9]{24}$/.test(cursor.k)||!Number.isSafeInteger(cursor.o)||cursor.o<0||cursor.o>this.maxCandidates)throw new CatalogInputError('Invalid cursor.');
      key=this.redis.key('catalog:query:'+cursor.k);offset=cursor.o;
      const value=await this.redis.command<string|null>('GET',key+':meta');
      if(!value)throw new CatalogInputError('This page expired. Start from the first page.');
      snapshot=JSON.parse(value) as QuerySnapshot;
      if(snapshot.fingerprint!==this.fingerprint(query))throw new CatalogInputError('Invalid cursor.');
      if(snapshot.total>0&&!await this.redis.command<number>('EXISTS',key))throw new CatalogInputError('This page expired. Start from the first page.');
    }else({key,snapshot}=await this.querySnapshot(query,current));
    const items:CatalogProxy[]=[];const now=Date.now();
    while(items.length<query.limit&&offset<snapshot.total){
      const ids=await this.redis.command<string[]>('ZREVRANGE',key,String(offset),String(Math.min(snapshot.total-1,offset+query.limit-items.length-1)));
      offset+=ids.length;if(!ids.length)break;
      items.push(...(await this.records(snapshot.generation,ids)).filter(p=>eligible(p,now,this.maxAge)&&matches(p,query)).map(p=>({...p,score:scoreProxy(p,now,this.maxAge)})));
    }
    if(!await this.redis.command<number>('EXISTS',key+':meta'))throw new CatalogInputError('This page expired. Start from the first page.');
    const nextCursor=offset<snapshot.total?Buffer.from(JSON.stringify({k:key.slice(key.lastIndexOf(':')+1),o:offset})).toString('base64url'):null;
    return {items,nextCursor,total:snapshot.total,status,generatedAt:snapshot.generatedAt};
  }
  async recommend(query:CatalogQuery,count:number,excludeIds:string[]):Promise<CatalogProxy[]>{
    if(!Number.isInteger(count)||count<1||count>100)throw new CatalogInputError('Select between 1 and 100 proxies.');
    const manifest=await this.manifest();if(!manifest)return [];
    const {key,snapshot}=await this.querySnapshot({...query,sort:'score'},manifest);
    const excluded=new Set(excludeIds),exits=new Set<string>();const winners:CatalogProxy[]=[],fallback:CatalogProxy[]=[];const now=Date.now();
    for(let start=0;start<snapshot.total&&winners.length<count;start+=BATCH){
      const ids=await this.redis.command<string[]>('ZREVRANGE',key,String(start),String(start+BATCH-1));if(!ids.length)break;
      for(const p of await this.records(manifest.generation,ids)){
        if(excluded.has(p.id)||!eligible(p,now,this.maxAge)||!matches(p,query))continue;
        p.score=scoreProxy(p,now,this.maxAge);const exit=p.exitIp||p.host;
        if(!exits.has(exit)){exits.add(exit);winners.push(p);if(winners.length===count)break;}
        else if(fallback.length<count)fallback.push(p);
      }
    }
    if(!await this.redis.command<number>('EXISTS',key+':meta'))throw new CatalogInputError('This page expired. Start from the first page.');
    winners.push(...fallback.slice(0,count-winners.length));
    return winners.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  }
  async all():Promise<CatalogProxy[]>{
    const manifest=await this.manifest();if(!manifest)return [];
    let cursor='0';const records:CatalogProxy[]=[];
    do{
      const [next,entries]=await this.redis.command<[string,string[]]>('HSCAN',this.redis.key(this.base(manifest.generation)+'records'),cursor,'COUNT',String(BATCH));cursor=next;
      for(let i=1;i<entries.length&&records.length<this.maxCandidates;i+=2)records.push(JSON.parse(entries[i]) as CatalogProxy);
    }while(cursor!=='0'&&records.length<this.maxCandidates);
    return records;
  }
  async createGeneration(records:CatalogProxy[],lease:RedisLease):Promise<string>{
    if(lease.signal.aborted)throw new RedisUnavailable();
    const generation=randomUUID(),base=this.redis.key(this.base(generation));
    const ok=await this.redis.command<number>('EVAL',`if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;redis.call('HSET',KEYS[2],'owner',ARGV[1],'createdAt',ARGV[2],'revision',0);redis.call('EXPIRE',KEYS[2],ARGV[3]);redis.call('SADD',KEYS[3],KEYS[2],KEYS[3]);redis.call('EXPIRE',KEYS[3],ARGV[3]);return 1`,'3',lease.key,base+'meta',base+'keys',lease.token,String(Date.now()),String(this.ttl));
    if(!ok)throw new RedisUnavailable();
    for(let start=0;start<Math.min(records.length,this.maxCandidates);start+=BATCH)await this.updateGeneration(generation,records.slice(start,Math.min(start+BATCH,this.maxCandidates)),lease);
    return generation;
  }
  async updateGeneration(generation:string,records:CatalogProxy[],lease:RedisLease):Promise<void>{
    if(!/^[a-f0-9-]{36}$/.test(generation)||lease.signal.aborted)throw new RedisUnavailable();
    const base=this.redis.key(this.base(generation));
    for(let start=0;start<records.length;start+=BATCH){
      if(lease.signal.aborted)throw new RedisUnavailable();
      const ok=await this.redis.command<number>('EVAL',UPSERT,'6',lease.key,base+'meta',base+'records',base+'score',base+'latency',base+'freshness',lease.token,base,String(this.ttl),String(Date.now()),String(this.maxAge),String(this.maxCandidates),JSON.stringify(records.slice(start,start+BATCH)));
      if(!ok)throw new RedisUnavailable();
    }
  }
  async activate(generation:string,lease:RedisLease):Promise<void>{
    if(lease.signal.aborted)throw new RedisUnavailable();
    const manifest:Manifest={generation,generatedAt:Date.now()};
    const previous=await this.redis.command<string>('EVAL',`if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('HGET',KEYS[2],'owner')~=ARGV[1] then return 'lost' end;local old=redis.call('GET',KEYS[3]);redis.call('SET',KEYS[3],ARGV[2],'EX',ARGV[3]);return old or ''`,'3',lease.key,this.redis.key(this.base(generation)+'meta'),this.redis.key('catalog:current'),lease.token,JSON.stringify(manifest),String(this.ttl));
    if(previous==='lost')throw new RedisUnavailable();
    const old=previous?JSON.parse(previous) as Manifest:null;
    if(old&&old.generation!==generation){
      const registry=this.redis.key(this.base(old.generation)+'keys');let cursor='0';
      do{
        const [next,keys]=await this.redis.command<[string,string[]]>('SSCAN',registry,cursor,'COUNT',String(BATCH));cursor=next;
        for(let start=0;start<keys.length;start+=BATCH){
          const batch=keys.slice(start,start+BATCH);
          const ok=await this.redis.command<number>('EVAL',`if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end;for i=2,#KEYS do redis.call('EXPIRE',KEYS[i],300) end;return 1`,String(batch.length+1),lease.key,...batch,lease.token);
          if(!ok)throw new RedisUnavailable();
        }
      }while(cursor!=='0');
    }
  }
  async publish(records:CatalogProxy[],lease:RedisLease):Promise<void>{await this.activate(await this.createGeneration(records,lease),lease);}
  /** Bounded NDJSON streaming avoids a second full serialized catalog in memory. */
  async saveSnapshot(records:CatalogProxy[],lease:RedisLease):Promise<void>{
    if(!await lease.renew())throw new RedisUnavailable();
    await mkdir(this.stateDir,{recursive:true});
    const path=join(this.stateDir,'catalog.json'),temp=join(this.stateDir,`catalog-${lease.token}.tmp`);
    try{
      const file=await open(temp,'w',0o600);
      try{
        await file.writeFile(JSON.stringify({version:2,savedAt:Date.now()})+'\n');
        for(let start=0;start<Math.min(records.length,this.maxCandidates);start+=BATCH){
          if(lease.signal.aborted)throw new RedisUnavailable();
          await file.writeFile(records.slice(start,Math.min(start+BATCH,this.maxCandidates)).map(p=>JSON.stringify(p)).join('\n')+'\n');
        }
        await file.sync();
      }finally{await file.close();}
      if(!await lease.renew()||lease.signal.aborted)throw new RedisUnavailable();
      await rename(temp,path);
    }finally{await unlink(temp).catch(()=>{});}
  }

  async restore(lease:RedisLease):Promise<void>{
    if(await this.manifest())return;
    const records:CatalogProxy[]=[];let remainder='',header=false,scanned=0,capped=false;
    try{
      for await(const chunk of createReadStream(join(this.stateDir,'catalog.json'),{encoding:'utf8',highWaterMark:64*1024})){
        remainder+=chunk;
        for(;;){
          const end=remainder.indexOf('\n');if(end<0)break;
          if(end>MAX_SNAPSHOT_LINE)throw new Error('Invalid snapshot');
          const line=remainder.slice(0,end);remainder=remainder.slice(end+1);if(!line)continue;
          const p=JSON.parse(line);
          if(!header){if(p.version!==2)return;header=true;continue;}
          if(scanned++>=this.maxCandidates){capped=true;break;}
          const canonical=normalizeCandidate(`${p.protocol}://${String(p.host).includes(':')?`[${p.host}]`:p.host}:${p.port}`,p.protocol,'restored');
          if(canonical?.id===p.id&&Array.isArray(p.sources)&&p.sources.length<=16&&p.sources.every((s:unknown)=>typeof s==='string')&&Number.isFinite(p.lastCheckedAt)&&Number.isFinite(p.lastSuccessAt)&&Number.isFinite(p.latencyMs)&&p.latencyMs>=0&&Number.isSafeInteger(p.checks)&&p.checks>=0&&Number.isSafeInteger(p.successes)&&p.successes>=0&&p.successes<=p.checks&&eligible(p,Date.now(),this.maxAge))records.push(p);
        }
        if(capped)break;
        if(remainder.length>MAX_SNAPSHOT_LINE)throw new Error('Invalid snapshot');
        if(records.length>=this.maxCandidates)break;
      }
      if(!capped&&remainder.trim())throw new Error('Truncated snapshot');
    }catch{return;}
    if(records.length)await this.publish(records,lease);
  }
}
