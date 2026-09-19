import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { ProxyProtocol } from '../types.ts';

export interface CatalogProxy {
  id: string; protocol: ProxyProtocol; host: string; port: number; sources: string[];
  exitIp?: string; country?: string; latencyMs: number; successes: number; checks: number;
  lastCheckedAt: number; lastSuccessAt: number; score: number;
}
export interface CatalogStatus { lastCompletedAt: number | null; nextRunAt: number; running: boolean; lastError?: string }
export interface CatalogQuery { q: string; protocol: string; country: string; sort: 'score' | 'latency' | 'freshness'; limit: number; cursor?: string }
export class CatalogInputError extends Error {}
export const PROTOCOLS = ['http','https','socks4','socks5'] as const;
export const ID = /^[a-f0-9]{32}$/;
export function nextBoundary(now: number, minutes: number): number { const interval = minutes * 60_000; return (Math.floor(now / interval) + 1) * interval; }

export function publicHost(host: string): boolean {
  if (host === 'localhost' || /\.(?:localhost|local|internal|invalid)$/.test(host)) return false;
  const kind = isIP(host);
  if (kind === 4) {
    const [a,b] = host.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===198&&(b===18||b===19)));
  }
  if (kind === 6) return /^[23]/.test(host) && !host.startsWith('2001:db8:');
  return host.length <= 253 && host.includes('.') && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host);
}

export function normalizeCandidate(raw: string, fallback: ProxyProtocol, source: string): CatalogProxy | null {
  try {
    const text = raw.trim();
    if (!text || text.startsWith('#') || text.length > 512) return null;
    const m = /^(?:(https?|socks4a?|socks5h?):\/\/)?(\[[a-f\d:.]+\]|[^\s/:@]+):(\d+)\/?$/i.exec(text);
    if (!m) return null;
    const scheme = (m[1]?.toLowerCase() || fallback).replace('socks4a','socks4').replace('socks5h','socks5') as ProxyProtocol;
    const port = Number(m[3]);
    if (!PROTOCOLS.includes(scheme) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const host = new URL(`http://${m[2]}`).hostname.toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'');
    if (!publicHost(host)) return null;
    return { id: createHash('sha256').update(`${scheme}|${host}|${port}`).digest('hex').slice(0,32), protocol:scheme,host,port,sources:[source],latencyMs:0,successes:0,checks:0,lastCheckedAt:0,lastSuccessAt:0,score:0 };
  } catch { return null; }
}

export function mergeCandidates(records: Iterable<CatalogProxy>, max = 100_000): CatalogProxy[] {
  const map = new Map<string,CatalogProxy>();
  for (const p of records) {
    const previous = map.get(p.id);
    if (previous) previous.sources = [...new Set([...previous.sources,...p.sources])].slice(0,16);
    else if (map.size < max) map.set(p.id,{...p,sources:[...p.sources]});
  }
  return [...map.values()];
}

export function parseCandidates(body: string, fallback: ProxyProtocol, source: string, max: number): CatalogProxy[] {
  const records: CatalogProxy[] = [];
  const add = (raw:string, protocol=fallback) => { const p=normalizeCandidate(raw,protocol,source); if(p && records.length<max) records.push(p); };
  try {
    const json: unknown = JSON.parse(body);
    const list = Array.isArray(json) ? json : json && typeof json==='object' && Array.isArray((json as {data?:unknown}).data) ? (json as {data:unknown[]}).data : [];
    for(const item of list.slice(0,max)) {
      if(typeof item==='string') { add(item); continue; }
      if(!item || typeof item!=='object') continue;
      const p=item as Record<string,unknown>;
      if(p.username || p.password || p.user || p.pass) continue;
      const protocols=Array.isArray(p.protocols)?p.protocols:[p.protocol??p.type??fallback];
      for(const protocol of protocols) if(PROTOCOLS.includes(protocol as ProxyProtocol)) {
        if(typeof p.proxy==='string') add(p.proxy,protocol as ProxyProtocol);
        else if(typeof (p.ip??p.host)==='string') { const host=String(p.ip??p.host); add(`${host.includes(':') ? `[${host.replace(/^\[|\]$/g,'')}]` : host}:${p.port}`,protocol as ProxyProtocol); }
      }
    }
  } catch {
    const lines=body.split(/\r?\n/);
    const columns=(line:string)=>Array.from(line.matchAll(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g),m=>m[1].replace(/^"|"$/g,'').replace(/""/g,'"').trim());
    const header=columns(lines[0]??'').map(s=>s.toLowerCase());
    const hostColumn=header.findIndex(s=>['ip','host','ip_address'].includes(s)),portColumn=header.indexOf('port');
    if(hostColumn>=0&&portColumn>=0){
      const protocolColumn=header.findIndex(s=>['protocol','type'].includes(s));
      for(const line of lines.slice(1,max+1)){
        const cells=columns(line);if(header.some((h,i)=>['username','password','user','pass'].includes(h)&&cells[i]))continue;
        const protocol=(protocolColumn>=0?cells[protocolColumn]?.toLowerCase():fallback) as ProxyProtocol;
        if(PROTOCOLS.includes(protocol)){const host=cells[hostColumn]??'';add(`${host.includes(':')?`[${host}]`:host}:${cells[portColumn]}`,protocol);}
      }
      return mergeCandidates(records,max);
    }
    // Tables are read as text only. Scripts and markup are never evaluated.
    const text=body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi,':').replace(/<[^>]*>/g,'\n').replace(/&amp;/g,'&');
    for(const line of text.split(/\r?\n/)) { if(records.length>=max) break; add(line); }
  }
  return mergeCandidates(records,max);
}

export function eligible(p: CatalogProxy, now:number, maxAge:number): boolean { return p.lastSuccessAt>0 && p.lastSuccessAt<=now && p.lastSuccessAt===p.lastCheckedAt && now-p.lastSuccessAt<maxAge; }
export function scoreProxy(p:CatalogProxy,now:number,maxAge:number):number {
  return .6*((p.successes+1)/(p.checks+2))+.25*(1000/(1000+Math.max(1,p.latencyMs)))+.15*Math.max(0,1-(now-p.lastSuccessAt)/maxAge);
}
export function matches(p:CatalogProxy,q:CatalogQuery):boolean {
  return (!q.protocol||p.protocol===q.protocol)&&(!q.country||p.country===q.country)&&(!q.q||searchText(p).includes(q.q));
}
export function searchText(p:CatalogProxy):string { return `${p.host} ${p.port} ${p.protocol} ${p.exitIp??''} ${p.country??''}`.toLowerCase(); }
export function trigrams(text:string):string[] { const out=new Set<string>(); for(let i=0;i<text.length-2;i++) out.add(text.slice(i,i+3)); return [...out]; }

/** O(n log k), with one winner per exit before filling with shared exits. */
export function selectTop(records:Iterable<CatalogProxy>,count:number):CatalogProxy[] {
  const exits=new Map<string,CatalogProxy>();
  const all:CatalogProxy[]=[];
  for(const p of records) { all.push(p); const exit=p.exitIp||p.host; const prior=exits.get(exit); if(!prior||p.score>prior.score) exits.set(exit,p); }
  const heap:CatalogProxy[]=[];
  const push=(p:CatalogProxy) => {
    if(heap.length<count) { heap.push(p); let i=heap.length-1; while(i>0){const parent=(i-1)>>1;if(heap[parent].score<=heap[i].score)break;[heap[parent],heap[i]]=[heap[i],heap[parent]];i=parent;} }
    else if(p.score>heap[0].score){heap[0]=p;let i=0;for(;;){let c=i*2+1;if(c>=heap.length)break;if(c+1<heap.length&&heap[c+1].score<heap[c].score)c++;if(heap[i].score<=heap[c].score)break;[heap[i],heap[c]]=[heap[c],heap[i]];i=c;}}
  };
  for(const p of exits.values()) push(p);
  if(heap.length<count){const selected=new Set(heap.map(p=>p.id));for(const p of all)if(!selected.has(p.id))push(p);}
  return heap.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
}

function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new CatalogInputError('Expected an object.');return value as Record<string,unknown>;}
export function validateQuery(value:unknown, extra:string[]=[]):CatalogQuery {
  const p=object(value); const allowed=new Set(['q','protocol','country','sort','limit','cursor',...extra]);
  if(Object.keys(p).some(k=>!allowed.has(k)))throw new CatalogInputError('Unknown catalog field.');
  for(const k of ['q','protocol','country','sort','cursor']) if(p[k]!==undefined&&typeof p[k]!=='string')throw new CatalogInputError('Invalid catalog filter.');
  const q=String(p.q??'').trim().toLowerCase(),protocol=String(p.protocol??''),country=String(p.country??'').toUpperCase(),sort=String(p.sort??'score');
  const limit=Number(p.limit??50);
  if(q.length>100 || (protocol&&!PROTOCOLS.includes(protocol as ProxyProtocol)) || (country&&!/^[A-Z]{2}$/.test(country)) || !['score','latency','freshness'].includes(sort)||!Number.isInteger(limit)||limit<1||limit>100||String(p.cursor??'').length>200)throw new CatalogInputError('Invalid catalog filter.');
  return {q,protocol,country,sort:sort as CatalogQuery['sort'],limit,cursor:p.cursor as string|undefined};
}
export function validateIds(value:unknown):string[]{const p=object(value);if(Object.keys(p).some(k=>k!=='ids')||!Array.isArray(p.ids)||p.ids.length>100||p.ids.some(id=>typeof id!=='string'||!ID.test(id)))throw new CatalogInputError('Supply up to 100 existing catalog IDs only.');return [...new Set(p.ids as string[])];}
