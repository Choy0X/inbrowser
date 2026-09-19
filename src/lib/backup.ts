import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import type { GatewaySettings } from "./gatewaySettings";
import type { Conversation, CustomProxy, ProviderConnection } from "./types";
import { parseProxyObject } from "./gateway/freeProxyList";
import type { Preferences } from "./preferences";
import type { ScheduledTask } from "./tasks";
import type { Skill, SkillResource } from "./skills";
import { stripResourceBodies } from "./skills";
import { getSkillResources, putSkillResources } from "./skillstore";
import { APP_NAME, APP_SLUG } from "./appConfig";

/**
 * Backup and restore.
 *
 * Everything InBrowser knows lives in one browser profile: clear site data, switch
 * browser, or open a private window and it is gone. With no server there is no
 * account to sync from, so an explicit export is the only way to move or keep a
 * copy of it.
 *
 * Provider connections and custom proxies are backed up by shape only —
 * `apiKey`/`password` are stripped from the exported object entirely (not just
 * blanked, so the field name itself never appears in the archive). A backup is a
 * file that gets emailed, synced and shared without much thought, and a leaked
 * credential is a real cost to the user; re-entering one after a restore takes
 * seconds by comparison.
 */

// 3: proxies changed from a CORS-forwarding `urlTemplate` to a real
// protocol/host/port, and the secret field was renamed authValue -> password.
// A v2 archive still parses; its proxies are run through migrateProxies() on
// restore, exactly as the ones in localStorage are, and dropped the same way.
const BACKUP_VERSION = 3;
const ENTRY = "backup.json";

export type BackedUpProvider = Omit<ProviderConnection, "apiKey">;
export type BackedUpProxy = Omit<CustomProxy, "password">;

export interface BackupPayload {
  version: number;
  exportedAt: number;
  conversations: Conversation[];
  preferences?: Preferences;
  tasks?: ScheduledTask[];
  /** Skills with their bundled resource bodies inlined, so a restore is complete. */
  skills?: (Skill & { resources?: SkillResource[] })[];
  providers?: BackedUpProvider[];
  proxies?: BackedUpProxy[];
  /** Optional for compatibility with older backups. */
  proxiesEnabled?: boolean;
}

export interface BackupContents {
  conversations: Conversation[];
  preferences?: Preferences;
  tasks?: ScheduledTask[];
  skills?: (Skill & { resources?: SkillResource[] })[];
  providers?: ProviderConnection[];
  proxies?: CustomProxy[];
  proxiesEnabled?: boolean;
}

/** Build a compressed backup archive. Skill resource bodies are pulled from IndexedDB. */
export async function exportBackup(contents: BackupContents): Promise<Blob> {
  const skills = await Promise.all(
    (contents.skills ?? []).map(async (skill) => {
      const resources = await getSkillResources(skill.id).catch(() => [] as SkillResource[]);
      return resources.length > 0 ? { ...skill, resources } : skill;
    })
  );

  const providers: BackedUpProvider[] = (contents.providers ?? []).map(({ apiKey: _apiKey, ...rest }) => rest);
  const proxies: BackedUpProxy[] = (contents.proxies ?? []).map(({ password: _password, ...rest }) => rest);

  const payload: BackupPayload = {
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    conversations: contents.conversations.filter((c) => !c.temporary && c.messages.length > 0),
    preferences: contents.preferences,
    tasks: contents.tasks,
    skills,
    providers,
    proxies,
    proxiesEnabled: typeof contents.proxiesEnabled === "boolean" ? contents.proxiesEnabled : undefined,
  };

  const zipped = zipSync({ [ENTRY]: strToU8(JSON.stringify(payload)) }, { level: 6 });
  return new Blob([zipped as unknown as BlobPart], { type: "application/zip" });
}

/** Read a backup archive (or a bare .json export) back into its parts. */
export function parseBackup(input: ArrayBuffer | Uint8Array): BackupPayload {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

  let json: string;
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes);
    } catch {
      throw new Error("That file is a ZIP archive but it couldn't be read.");
    }
    const key = Object.keys(files).find((k) => k.replace(/\\/g, "/").endsWith(ENTRY));
    if (!key) throw new Error(`That archive doesn't contain an ${APP_NAME} backup.`);
    json = strFromU8(files[key]);
  } else {
    json = strFromU8(bytes);
  }

  let parsed: BackupPayload;
  try {
    parsed = JSON.parse(json) as BackupPayload;
  } catch {
    throw new Error(`That file isn't a readable ${APP_NAME} backup.`);
  }
  if (!parsed || !Array.isArray(parsed.conversations)) {
    throw new Error(`That file isn't an ${APP_NAME} backup.`);
  }
  if (parsed.version > BACKUP_VERSION) {
    throw new Error(`This backup was made by a newer version of ${APP_NAME} (format ${parsed.version}).`);
  }
  return parsed;
}

/** Older backups leave the current master choice alone; explicit booleans restore it. */
export function restoreProxyMasterSetting(settings: GatewaySettings, payload: Pick<BackupPayload, "proxiesEnabled">): GatewaySettings {
  return typeof payload.proxiesEnabled === "boolean" && payload.proxiesEnabled !== settings.proxiesEnabled
    ? { ...settings, proxiesEnabled: payload.proxiesEnabled }
    : settings;
}

export interface MergeResult<T> {
  merged: T[];
  added: number;
  skipped: number;
}

/** Merge by id, keeping what is already here - a restore never overwrites live data. */
export function mergeById<T extends { id: string }>(current: T[], incoming: T[] | undefined): MergeResult<T> {
  if (!incoming || incoming.length === 0) return { merged: current, added: 0, skipped: 0 };
  const seen = new Set(current.map((item) => item.id));
  const fresh = incoming.filter((item) => !seen.has(item.id));
  return { merged: [...current, ...fresh], added: fresh.length, skipped: incoming.length - fresh.length };
}

/**
 * Restore skills, writing their resource bodies to IndexedDB and returning
 * records stripped to a manifest - the same split the rest of the app uses.
 */
export async function restoreSkills(
  current: Skill[],
  incoming: BackupPayload["skills"],
): Promise<MergeResult<Skill>> {
  if (!incoming || incoming.length === 0) return { merged: current, added: 0, skipped: 0 };

  const byName = new Set(current.map((s) => s.name.toLowerCase()));
  const byId = new Set(current.map((s) => s.id));
  const fresh = incoming.filter((s) => !byId.has(s.id) && !byName.has(s.name.toLowerCase()));

  for (const skill of fresh) {
    if (skill.resources && skill.resources.length > 0) {
      await putSkillResources(skill.id, skill.resources).catch(() => {
        /* a skill that loses its files still restores its instructions */
      });
    }
  }

  return {
    merged: [...current, ...fresh.map(stripResourceBodies)],
    added: fresh.length,
    skipped: incoming.length - fresh.length,
  };
}

export function backupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${APP_SLUG}-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.zip`;
}

/** Explicit standalone exports preserve authentication; full backups still strip passwords. */
export function exportProxiesPayload(proxies: CustomProxy[]): CustomProxy[] {
  return proxies.map(proxy => ({ ...proxy }));
}

export function parseProxiesPayload(json: unknown): CustomProxy[] {
  const arr = Array.isArray(json) ? json : (json as { proxies?: unknown } | null)?.proxies;
  if (!Array.isArray(arr)) throw new Error("That file doesn't contain a proxy list.");
  if (arr.some(p => p && typeof p === "object" && "urlTemplate" in p)) {
    throw new Error(`That's a CORS-proxy list from an older version of ${APP_NAME}. Those can't be converted to real proxies - see Settings > Proxies.`);
  }
  return arr.map(row => {
    const proxy = parseProxyObject(row, "http", "Imported list");
    if (!proxy) throw new Error("That file doesn't look like a proxy export.");
    return proxy;
  });
}

export function proxiesFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${APP_SLUG}-proxies-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
}
