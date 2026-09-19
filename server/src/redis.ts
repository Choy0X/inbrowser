import { createClient } from 'redis';
import { createHmac, randomUUID } from 'node:crypto';
import type { RelayConfig } from './config.ts';

export class RedisUnavailable extends Error {
  constructor() { super('Shared state is temporarily unavailable.'); }
}

/** Only this adapter owns connections. No request payloads belong in Redis. */
export class SharedRedis {
  readonly prefix: string;
  private readonly client;
  private readonly timeout: number;
  private stopped = true;
  private connecting?: Promise<void>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private socketConnected = false;
  private connectExpired = false;
  constructor(config: RelayConfig['redis']) {
    this.prefix = config.keyPrefix;
    this.timeout = config.commandTimeoutMs;
    this.client = createClient({
      url: config.url, password: config.password, disableOfflineQueue: true,
      commandsQueueMaxLength: 2048,
      // Own reconnect scheduling so close can settle every pending connection.
      // node-redis's internal reconnect promise is otherwise inaccessible.
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    // Errors deliberately carry neither connection strings nor credentials into logs.
    this.client.on('error', () => this.scheduleReconnect());
    this.client.on('end', () => this.scheduleReconnect());
    this.client.on('connect', () => {
      this.socketConnected = true;
      if (this.connectExpired) {
        // The initiator awaits microtasks before queuing its handshake. A
        // timer lets it finish queuing before destroy rejects its replies.
        setTimeout(() => { if (this.client.isOpen) this.client.destroy(); }, 0);
      }
    });
  }
  start(): void {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect();
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.client.isReady || this.reconnectTimer) return;
    const delay = Math.min(5000, 100 * 2 ** Math.min(this.failures++, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }
  private connect(): void {
    if (this.stopped || this.client.isOpen || this.connecting) return;
    this.socketConnected = false;
    this.connectExpired = false;
    // connectTimeout bounds TCP establishment. This also bounds the Redis
    // handshake if a peer accepts TCP but never sends protocol replies.
    const deadline = setTimeout(() => {
      this.connectExpired = true;
      if (this.socketConnected && this.client.isOpen) this.client.destroy();
    }, 2000);
    this.connecting = this.client.connect().then(() => {
      if (this.stopped) {
        if (this.client.isOpen) this.client.destroy();
      } else {
        this.failures = 0;
      }
    }).catch(() => {}).finally(() => {
      clearTimeout(deadline);
      this.connecting = undefined;
      if (!this.stopped && !this.client.isReady) this.scheduleReconnect();
    });
  }
  get ready(): boolean { return this.client.isReady; }
  async waitReady(timeoutMs = 2000): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (!this.ready && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    return this.ready;
  }
  async command<T = unknown>(...args: string[]): Promise<T> {
    if (!this.client.isReady) throw new RedisUnavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // node-redis's command timeout covers its unsent queue, not the time
      // waiting for a reply. Close the transport on an end-to-end timeout so
      // pending commands cannot be replayed or accumulate behind a stalled read.
      return await Promise.race([
        this.client.sendCommand(args, { timeout: this.timeout }) as Promise<T>,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (this.client.isOpen) this.client.destroy();
            this.scheduleReconnect();
            reject(new RedisUnavailable());
          }, this.timeout);
        }),
      ]);
    }
    catch { throw new RedisUnavailable(); }
    finally { clearTimeout(timer); }
  }
  key(suffix: string): string { return this.prefix + suffix; }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    // Destroying while node-redis is awaiting socket creation leaves that
    // unassigned socket alive after close. Its bounded connection/handshake
    // must settle first, then the success handler observes stopped and closes.
    await this.connecting;
    if (this.client.isOpen) this.client.destroy();
  }
  async json<T>(key: string): Promise<T | null> {
    const value = await this.command<string | null>('GET', this.key(key));
    return value ? JSON.parse(value) as T : null;
  }
}

const LIMIT = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return {n,redis.call('PTTL',KEYS[1])}`;
export async function rateLimit(redis: SharedRedis, secret: string, clientKey: string, limit: number, scope = 'relay'): Promise<{limited:boolean;retryAfterSeconds:number}> {
  const id = createHmac('sha256', secret || 'unconfigured').update(`rate:${scope}:${clientKey}`).digest('hex');
  const [count, ttl] = await redis.command<number[]>('EVAL', LIMIT, '1', redis.key(`rate:${scope}:${id}`), '60000');
  return { limited: count > limit, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
}

const RENEW = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`;
export class RedisLease {
  readonly redis: SharedRedis;
  readonly ttl: number;
  readonly token = randomUUID();
  readonly key: string;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private constructor(redis: SharedRedis, name: string, ttl: number) {
    this.redis = redis; this.ttl = ttl;
    this.key = redis.key(`lease:${name}`); this.signal = this.controller.signal;
  }
  static async acquire(redis: SharedRedis, name: string, ttl = 60_000): Promise<RedisLease | null> {
    const lease = new RedisLease(redis, name, ttl);
    if (!await redis.command('SET', lease.key, lease.token, 'NX', 'PX', String(ttl))) return null;
    lease.timer = setInterval(() => { void lease.renew(); }, Math.floor(ttl / 3));
    lease.timer.unref();
    return lease;
  }
  async renew(): Promise<boolean> {
    try {
      if (this.signal.aborted) return false;
      const ok = await this.redis.command<number>('EVAL', RENEW, '1', this.key, this.token, String(this.ttl));
      if (!ok) this.controller.abort();
      return !!ok;
    } catch { this.controller.abort(); return false; }
  }
  async release(): Promise<void> {
    clearInterval(this.timer); this.controller.abort();
    await this.redis.command('EVAL', RELEASE, '1', this.key, this.token).catch(() => {});
  }
  /** Atomic ownership check and small public-state write. */
  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (this.signal.aborted) throw new RedisUnavailable();
    const ok = await this.redis.command<number>('EVAL',
      `if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[2],ARGV[2],'EX',ARGV[3]); return 1`,
      '2', this.key, this.redis.key(key), this.token, JSON.stringify(value), String(ttlSeconds));
    if (!ok) { this.controller.abort(); throw new RedisUnavailable(); }
  }
}
