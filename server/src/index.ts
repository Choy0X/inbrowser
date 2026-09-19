/**
 * InBrowser's server.
 *
 * It serves the built client, and it forwards
 * a proxied request to the Cloudflare Worker that dials the user's proxy (that
 * Worker is a separate repository, `inbrowser-relay`). Scheduled jobs maintain
 * public proxy and suggestion catalogs in Redis; public routes only read them.
 *
 * Serving the client from the same origin as the relay is the reason this exists
 * at all: it removes CORS, the X-Relay-Meta preflight and the relay URL the
 * client would otherwise have to be told, and it puts the COOP/COEP headers that
 * interactive Pyodide depends on in one place instead of two that can drift.
 *
 * With no proxy configured, nothing here is on the path between the user and a
 * provider. The browser still calls providers directly, which is what keeps
 * their per-IP rate limits per-user.
 *
 * Deploy behind Cloudflare with proxied DNS. That is not optional advice: it
 * hides this host's address, and it edge-caches the ~113 MB of language-runtime
 * assets that would otherwise leave this server on every cold load.
 *
 * ONE PROCESS OR SEVERAL. `clusterWorkers` > 1 forks that many workers, which
 * share the listening socket. The reason is not raw throughput: at the
 * concurrency this is sized for, most of the CPU goes on per-message work for
 * streamed replies, and a single process means one garbage collection pause
 * stalls *every* live stream at once. Four workers make that a quarter of them.
 * Everything that must happen once rather than N times - the daily suggestion
 * refresh, the metrics endpoint - lives in the primary and is described below.
 *
 * The invariants for the proxied path - no logging of request fields, nothing
 * persisted, no buffering, an allowlisted dependency set - are documented and
 * enforced in app.ts. Read that before changing anything here.
 */
import cluster from "node:cluster";
import os from "node:os";
import { buildApp } from "./app.ts";
import { isPlaceholderSecret, loadConfig, type RelayConfig } from "./config.ts";
import { registerStatic } from "./static.ts";
import { emptySnapshot, mergeSnapshots, snapshot, type MetricsSnapshot } from "./metrics.ts";
import { startMetricsServer } from "./metricsServer.ts";
import { startSuggestionScheduler } from './suggestions.ts';
import { SharedRedis } from './redis.ts';
import { CatalogRepository } from './catalog/repository.ts';
import { startCatalogScheduler } from './catalog/scheduler.ts';

/** How often a worker reports its counters to the primary. */
const METRICS_PUSH_MS = 5_000;

/**
 * How long a draining worker gets to finish the streams it already has.
 *
 * Past forward.ts's own 120s request timeout, so no request the relay would
 * have allowed is cut short by a deploy; far short of the Worker's 10-minute
 * per-tunnel cap, which would make every restart a ten-minute wait. The
 * systemd unit's TimeoutStopSec sits above this so systemd lets it run.
 */
const DRAIN_TIMEOUT_MS = 150_000;

type WorkerMessage =
  | { type: "metrics"; snapshot: MetricsSnapshot };



function resolveWorkerCount(config: RelayConfig): number {
  // Dev is always one process. `npm run dev` is `node --watch`, and dev.ts runs
  // Vite in middleware mode - N workers would mean N Vite instances each
  // building the same graph, which is slow at best and confusing at worst.
  if (config.dev) return 1;
  if (config.clusterWorkers > 0) return config.clusterWorkers;
  return Math.min(4, Math.max(1, os.availableParallelism() - 2));
}

/**
 * The primary: forks workers, owns the things that must happen once, and
 * coordinates shutdown. It serves no traffic itself.
 */
async function runPrimary(config: RelayConfig, workerCount: number): Promise<void> {
  const latest = new Map<number, MetricsSnapshot>();
  let draining = false;

  const fork = () => {
    const worker = cluster.fork();
    worker.on("message", (msg: WorkerMessage) => {
      if (msg?.type === "metrics") {
        latest.set(worker.id, msg.snapshot);
      }
    });
    worker.on("exit", () => {
      latest.delete(worker.id);
      // A worker that exits during a drain is doing what it was told. Only
      // replace one that died on its own.
      if (!draining) fork();
    });
    return worker;
  };

  for (let i = 0; i < workerCount; i++) fork();

  // Generation happens here, once, and the result is pushed out. See the
  // comment on getPoolSnapshot for why this cannot live in the workers.
  const shared = startSharedJobs(config);

  if (config.metricsPort > 0) {
    const server = await startMetricsServer(config.metricsPort, () => {
      let merged = emptySnapshot();
      for (const snap of latest.values()) merged = mergeSnapshots(merged, snap);
      return { snapshot: merged, workers: latest.size };
    });
    console.log(`InBrowser metrics on 127.0.0.1:${server.port}/metrics`);
  }

  /**
   * Retire one worker without dropping what it is already serving.
   *
   * `disconnect()` rather than asking the worker to close its server: with
   * round-robin distribution the primary is the thing handing out connections,
   * and only disconnect stops it doing so for this worker. Established
   * connections stay up, and 'disconnect' fires once they have ended.
   */
  const retire = (worker: import("node:cluster").Worker): Promise<void> =>
    new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        // Out of patience. Everything still open here has outlived any request
        // the relay would have allowed.
        try {
          worker.kill();
        } catch {
          /* already gone */
        }
        finish();
      }, DRAIN_TIMEOUT_MS);
      timer.unref();
      worker.once("disconnect", finish);
      worker.once("exit", finish);
      try {
        worker.disconnect();
      } catch {
        finish();
      }
    });

  // SIGHUP: replace workers one at a time, so capacity never drops to zero and
  // no stream is cut. cluster.fork() re-executes this file from disk, so a new
  // worker picks up new code; only the primary's own code is stale, which is
  // tolerable because the primary is this file and nothing else.
  process.on("SIGHUP", () => {
    void (async () => {
      for (const worker of Object.values(cluster.workers ?? {})) {
        if (!worker) continue;
        const replacement = fork();
        await new Promise<void>((resolve) => {
          replacement.once("listening", () => resolve());
          replacement.once("exit", () => resolve());
        });
        await retire(worker);
      }
    })();
  });

  const shutdown = () => {
    if (draining) return;
    draining = true;
    shared.stop();
    void (async () => {
      await Promise.all(
        Object.values(cluster.workers ?? {})
          .filter((w): w is import("node:cluster").Worker => Boolean(w))
          .map(retire)
      );
      process.exit(0);
    })();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  console.log(`InBrowser primary: ${workerCount} worker${workerCount === 1 ? "" : "s"} on :${config.port}`);
}

function startSharedJobs(config: RelayConfig, existing?: SharedRedis) {
  const redis = existing ?? new SharedRedis(config.redis);
  redis.start();
  const stopSuggestions = startSuggestionScheduler(redis);
  const stopCatalog = startCatalogScheduler(config, new CatalogRepository(redis, config.freeProxyCatalog.intervalMinutes, config.freeProxyCatalog.stateDir, config.freeProxyCatalog.maxCandidates));
  return { stop() { stopSuggestions(); stopCatalog(); if (!existing) void redis.close(); } };
}

/** A worker, or the whole server when running unclustered. */
async function runServer(config: RelayConfig): Promise<void> {
  const redis = new SharedRedis(config.redis);
  redis.start();
  const app = buildApp(config, redis);
  app.addHook('onClose', async () => redis.close());

  if (config.dev) {
    // Dynamic, and marked --external in the bundle, so the production artifact
    // never pulls in Vite and the whole dev toolchain behind it.
    const { attachVite } = await import("./dev.ts");
    await attachVite(app, config);
  } else {
    await registerStatic(app, config);
  }

  // A slow model can leave a stream idle for a long time; the real bound is the
  // per-request timeout in forward.ts. Headers should still arrive promptly.
  app.server.headersTimeout = 30_000;

  if (cluster.isWorker) {
    const timer = setInterval(() => {
      process.send?.({ type: "metrics", snapshot: snapshot() } satisfies WorkerMessage);
    }, METRICS_PUSH_MS);
    timer.unref();
  } else {
    // Unclustered: this process is the only one, so it owns both.
    const shared = startSharedJobs(config, redis);
    app.addHook('onClose', async () => shared.stop());
    if (config.metricsPort > 0) {
      const server = await startMetricsServer(config.metricsPort, () => ({
        snapshot: snapshot(),
        workers: 1,
      }));
      console.log(`InBrowser metrics on 127.0.0.1:${server.port}/metrics`);
    }
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });

  if (!cluster.isWorker) {
    console.log(`InBrowser ${config.dev ? "dev" : "server"} listening on :${config.port}`);
  }
}

// Wrapped in main() rather than using top-level await: the production artifact
// is a CJS bundle (Fastify's dependencies do dynamic `require`s that esbuild's
// ESM output cannot satisfy), and CJS has no top-level await.
async function main(): Promise<void> {
  const config = loadConfig();
  const workerCount = resolveWorkerCount(config);

  // Warnings belong to whichever process a human is looking at, and printing
  // them once per worker would bury them.
  if (cluster.isPrimary) {
    if (!config.workerUrl) {
      console.warn("No worker URL is set - proxied requests will return 503. See `server` in config.json.");
    } else if (isPlaceholderSecret(config.relaySecret)) {
      // config.json is committed, so a secret written into it is public, and a
      // public secret authenticates nobody. Saying so plainly beats running in a
      // state that looks configured and is not.
      console.warn(
        "The relay secret is unset or still a placeholder - proxied requests will fail. " +
          "Set RELAY_SECRET in the environment to the same value the worker was deployed " +
          "with; it has to match, not merely exist. Put it in the environment rather than " +
          "config.json, which is committed and therefore public."
      );
    }
  }

  if (workerCount > 1 && cluster.isPrimary) {
    await runPrimary(config, workerCount);
    return;
  }
  await runServer(config);
}

void main();
