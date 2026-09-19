import type { FastifyInstance } from 'fastify';
import type { CatalogReader } from './repository.ts';
import { validateIds, validateQuery, CatalogInputError, ID } from './model.ts';
import { RedisUnavailable } from '../redis.ts';

/** Deliberately injected read-only capability: no network checker can be called here. */
export function registerCatalogRoutes(app:FastifyInstance,reader:CatalogReader,admit: (key:string)=>Promise<boolean>):void {
  app.register(async scope=>{
    // The relay's wildcard parser streams request bodies. JSON parsing is scoped
    // to catalog routes only; provider streams still bypass all body buffering.
    scope.removeAllContentTypeParsers();scope.addContentTypeParser('application/json',{parseAs:'string',bodyLimit:32768},(_request,body,done)=>{try{done(null,JSON.parse(String(body)));}catch{done(new CatalogInputError('Invalid JSON.'));}});
    scope.setErrorHandler((error,_request,reply)=>{
      if(error instanceof CatalogInputError)return reply.code(400).send({code:'catalog_invalid_request',error:error.message});
      if(error instanceof RedisUnavailable)return reply.code(503).header('Retry-After','5').send({code:'shared_state_unavailable',error:error.message});
      return reply.code((error as {statusCode?:number}).statusCode===413?413:503).send({code:'catalog_unavailable',error:'The proxy catalog is temporarily unavailable.'});
    });
    scope.addHook('onRequest',async(request,reply)=>{
      reply.header('Cache-Control','no-store');
      const key=String(request.headers['cf-connecting-ip']??request.socket.remoteAddress??'unknown');
      if(!await admit(key))return reply.code(429).header('Retry-After','60').send({code:'rate_limited',error:'Too many catalog requests.'});
    });
    scope.get('/v1/free-proxies',async request=>reader.page(validateQuery(request.query)));
    scope.post('/v1/free-proxies/resolve',async request=>reader.resolve(validateIds(request.body)));
    scope.post('/v1/free-proxies/recommendations',async request=>{
      const query=validateQuery(request.body,['count','excludeIds']);const body=request.body as Record<string,unknown>;
      const count=body.count??10,excluded=body.excludeIds??[];
      if(typeof count!=='number'||!Number.isInteger(count)||count<1||count>100||!Array.isArray(excluded)||excluded.length>10_000||excluded.some(id=>typeof id!=='string'||!ID.test(id)))throw new CatalogInputError('Invalid recommendation selection.');
      return {items:await reader.recommend(query,count,excluded)};
    });
  });
}
