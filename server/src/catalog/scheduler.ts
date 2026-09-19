import { setTimeout as delay } from 'node:timers/promises';
import type { RelayConfig } from '../config.ts';
import { isPlaceholderSecret } from '../config.ts';
import { RedisLease } from '../redis.ts';
import { CatalogRepository } from './repository.ts';
import { collectCandidates, checkCandidate, DiscoveryUnavailable } from './discovery.ts';
import { eligible, mergeCandidates, nextBoundary, scoreProxy, type CatalogProxy } from './model.ts';

export interface CatalogJobIO { collect:typeof collectCandidates; check:typeof checkCandidate }
const productionIO:CatalogJobIO={collect:collectCandidates,check:checkCandidate};

/** Called only by the server scheduler. No public route imports this module. */
export async function runCatalogJob(config:RelayConfig,repository:CatalogRepository,shutdown:AbortSignal,io:CatalogJobIO=productionIO,heldLease?:RedisLease):Promise<void>{
  if(isPlaceholderSecret(config.relaySecret)||shutdown.aborted)return;
  const lease=heldLease??await RedisLease.acquire(repository.redis,'catalog-job');if(!lease)return;
  const controller=new AbortController();const signal=AbortSignal.any([lease.signal,shutdown,controller.signal]);
  const settings=config.freeProxyCatalog;let lastCompletedAt:number|null=null;
  const setStatus=(running:boolean,lastCompletedAt:number|null,lastError?:string)=>lease.setJson('catalog:status',{running,lastCompletedAt,nextRunAt:nextBoundary(Date.now(),settings.intervalMinutes),...(lastError?{lastError}:{})},settings.intervalMinutes*180);
  try{
    lastCompletedAt=(await repository.status()).lastCompletedAt;
    await setStatus(true,lastCompletedAt);
    const previous=await repository.all();
    // Record the first attempt before outbound work. An empty or interrupted
    // initial run must not become a new startup scan after Redis loss/restart.
    if(!await repository.hasSnapshot())await repository.saveSnapshot(previous,lease);
    signal.throwIfAborted();
    const found=await io.collect(config.relaySecret,signal,settings.maxCandidates,previous);
    signal.throwIfAborted();
    const old=new Map(previous.map(p=>[p.id,p]));
    // Reserve discovery capacity even when an earlier run filled the catalog.
    // An endpoint that succeeded once must not crowd out new sources forever.
    const fresh=previous.filter(p=>eligible(p,Date.now(),repository.maxAge)).sort((a,b)=>b.score-a.score);
    const discovered=found.filter(p=>!old.has(p.id));
    const retained=fresh.slice(0,discovered.length?Math.floor(settings.maxCandidates*.75):settings.maxCandidates);
    const merged=mergeCandidates([...retained,...discovered,...fresh,...found,...previous],settings.maxCandidates).map(p=>old.has(p.id)?{...old.get(p.id)!,sources:p.sources}:p);
    const generation=await repository.createGeneration(merged,lease);
    await repository.activate(generation,lease);
    let cursor=0,nextStart=Date.now();let failure:unknown;
    const pending:CatalogProxy[]=[];
    let flushing=Promise.resolve();
    const flush=()=>{const batch=pending.splice(0,100);if(batch.length)flushing=flushing.then(()=>repository.updateGeneration(generation,batch,lease));return flushing;};
    async function worker(){
      while(cursor<merged.length&&!signal.aborted){
        const slot=nextStart;nextStart=Math.max(nextStart,Date.now())+1000/settings.startsPerSecond;
        await delay(Math.max(0,slot-Date.now()),undefined,{signal});
        signal.throwIfAborted();const index=cursor++;if(index>=merged.length)break;
        const p=merged[index];
        try{
          const result=await io.check(p,config,signal);const now=Math.max(Date.now(),p.lastSuccessAt+1);
          const next={...p,checks:p.checks+1,lastCheckedAt:now,...(result?{...result,successes:p.successes+1,lastSuccessAt:now}:{})};
          next.score=scoreProxy(next,now,repository.maxAge);merged[index]=next;pending.push(next);
          if(pending.length>=100)await flush();
        }catch(error){failure=error;controller.abort();throw error;}
      }
    }
    const settled=await Promise.allSettled(Array.from({length:Math.min(settings.concurrency,merged.length)},worker));
    // Always settle queued writes before releasing ownership or saving a snapshot.
    await flush();await flushing;
    if(signal.aborted||settled.some(r=>r.status==='rejected'))throw failure??new DiscoveryUnavailable();
    await repository.saveSnapshot(merged,lease);
    await setStatus(false,Date.now());
  }catch(error){
    controller.abort();
    if(!lease.signal.aborted)await setStatus(false,lastCompletedAt,error instanceof DiscoveryUnavailable?'relay_unavailable':'collection_interrupted').catch(()=>{});
  }finally{controller.abort();if(!heldLease)await lease.release();}
}

export function startCatalogScheduler(config:RelayConfig,repository:CatalogRepository,runJob=runCatalogJob):()=>void{
  if(!config.freeProxyCatalog.enabled)return ()=>{};
  const controller=new AbortController();let nextRun=nextBoundary(Date.now(),config.freeProxyCatalog.intervalMinutes),busy=false,restoring=false;
  const restore=async()=>{
    if(restoring||busy||!repository.redis.ready||controller.signal.aborted)return;
    restoring=true;
    try{
      if(await repository.manifest())return;
      const lease=await RedisLease.acquire(repository.redis,'catalog-job');if(!lease)return;
      try{
        await repository.restore(lease);
        // Only a genuinely new installation gets an immediate collection.
        // The same lease spans restoration, the durable marker and discovery,
        // preventing a second primary from racing the initial run.
        if(!controller.signal.aborted&&!isPlaceholderSecret(config.relaySecret)&&!await repository.hasSnapshot()&&!await repository.manifest()){
          busy=true;
          try{await runJob(config,repository,controller.signal,productionIO,lease);}
          finally{busy=false;}
        }
      }finally{await lease.release();}
    }catch{/* Recovery waits for the next timer. Existing snapshots never trigger a scan. */}
    finally{restoring=false;}
  };
  const tick=()=>{
    if(Date.now()>=nextRun){
      nextRun=nextBoundary(Date.now(),config.freeProxyCatalog.intervalMinutes);
      if(!busy&&!restoring&&repository.redis.ready){busy=true;void runJob(config,repository,controller.signal).catch(()=>{}).finally(()=>{busy=false;});}
    }
  };
  const timer=setInterval(tick,1000),recovery=setInterval(()=>{void restore();},15_000);
  timer.unref();recovery.unref();void restore();
  return ()=>{controller.abort();clearInterval(timer);clearInterval(recovery);};
}
