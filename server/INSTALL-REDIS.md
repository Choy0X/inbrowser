# Dedicated Redis for the free proxy catalog

The local `install.sh` provisions Redis 7 or newer from the configured Debian apt
repositories (`redis-server` and `redis-tools`). Use a supported Debian release
with the official Debian package sources enabled. No Redis Stack or RedisSearch
module is required. The installer file is intentionally gitignored and must be
copied onto the deployment host separately.

Run the normal installer with its domain and certificate options. The additional
`--redis-maxmemory-mb 1024` option sets the dedicated cache's memory limit, with
1024 MB as the default. This limit covers Redis data, so reserve additional host
memory for Redis overhead, the app, and Caddy.

The installer creates:

| Resource | Purpose |
| --- | --- |
| `inbrowser-redis.service` | Dedicated Redis listening only on `127.0.0.1:6380` |
| `/etc/inbrowser/redis.env` | Root-owned, mode 0600 app environment and password |
| `/etc/inbrowser-redis/redis.conf` | Root-owned, group redis, mode 0640 configuration |
| `/var/lib/inbrowser/catalog` | Durable catalog snapshot directory used by the app |

The password is randomly generated once and preserved on subsequent installer
runs. The separate Redis configuration directory is mode 0750, owned by
root:redis. `/etc/inbrowser` remains root-only. The password is also present in
the protected Redis config as `requirepass`; do not share either secret file.
`--rotate-secret` rotates only the existing relay secret, not Redis credentials.

The app receives `REDIS_URL=redis://127.0.0.1:6380`, `REDIS_PASSWORD`,
`REDIS_KEY_PREFIX=inbrowser:v1:`, and
`FREE_PROXY_STATE_DIR=/var/lib/inbrowser/catalog`. The URL contains no password.
Redis uses its default ACL user. The installer never adds a Redis firewall rule
or edits `/etc/redis/redis.conf` or the distro Redis service on port 6379. Debian
package installation may start its own default service; that service remains
independent of the dedicated InBrowser instance.

Redis persistence is disabled (`save ""`, `appendonly no`). The catalog snapshot
on disk is the durable recovery source. Redis uses `protected-mode yes` and
`maxmemory-policy noeviction`; writes fail when the configured data limit is
reached instead of evicting catalog or coordination keys. Monitor capacity and
rerun the installer with a larger `--redis-maxmemory-mb` value when appropriate.

The app unit uses `After` and `Wants` for Redis, with no `BindsTo` relationship.
A Redis restart does not cause systemd to stop the app or sever its live streams.
`StateDirectory=inbrowser` makes `/var/lib/inbrowser` writable to the app while
retaining `ProtectSystem=strict` for the rest of the filesystem. Rerunning the
installer preserves the Redis password and restarts Redis only when its managed
content changes. The normal installer still restarts the app during deployment.

## Verification and troubleshooting

The installer waits for an authenticated `PING` before starting the app and
rechecks it during final verification. It supplies authentication through the
child process environment, never command arguments or an authenticated URL.

Inspect status and listening addresses without printing credentials:

```sh
sudo systemctl status inbrowser-redis inbrowser
sudo journalctl -u inbrowser-redis -n 50 --no-pager
sudo ss -ltnp 'sport = :6380'
sudo stat -c '%a %U:%G %n' /etc/inbrowser/redis.env /etc/inbrowser-redis/redis.conf
```

An explicit authenticated check, run as root in a shell with tracing disabled:

```sh
sudo bash <<'SH'
set +x
password=$(sed -n 's/^REDIS_PASSWORD=//p' /etc/inbrowser/redis.env)
[[ $password =~ ^[a-f0-9]{64}$ ]] || exit 1
REDISCLI_AUTH="$password" timeout 5 redis-cli --raw -h 127.0.0.1 -p 6380 PING
unset password
SH
```

Expected output is `PONG`. Do not use `redis-cli -a`, print the secret files,
inspect the app's full environment, or paste their contents into support logs.
If port 6380 is already occupied by another service, the installer stops; inspect
the owner before resolving the conflict. If the secret file is malformed,
restore its original 64-character hexadecimal password from a secure backup.
Do not delete it merely to make a rerun pass, since doing so changes credentials.

Redis service failures should first be checked with its journal and file modes.
If the catalog is unavailable after a restart, verify the app can read and write
`/var/lib/inbrowser/catalog` and inspect the app journal. An empty Redis process
is expected after restart because Redis persistence is disabled.

## Validation scope

The installer configuration was checked in a disposable Debian Bookworm
container using the official Debian Redis package. Checks covered real
authenticated Redis readiness, rejection without authentication, effective
Redis settings, file ownership and modes, password preservation, unchanged
reruns, memory-limit changes, preservation of the distro Redis configuration,
and a dry run that left generated files unchanged. Both generated systemd units
passed `systemd-analyze verify`.

The container did not boot systemd. Its test harness substituted service-manager
calls and started Redis under the actual redis user, so full systemd startup,
ordering, and runtime sandbox behavior still require verification on the target
Debian host. The app's existing `/bin/kill` reload command requires the standard
process tools package, which was installed in the minimal test container.
