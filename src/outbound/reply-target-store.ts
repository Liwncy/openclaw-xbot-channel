import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { XbotReplyTarget } from '../types.ts';
import { ensureXbotStateDir } from './state-dir.ts';

type StoreFile = {
  version: 1;
  targets: Record<string, XbotReplyTarget>;
};

let cache: StoreFile | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function storePath(): Promise<string> {
  const dir = await ensureXbotStateDir();
  return path.join(dir, 'reply-targets.json');
}

async function load(): Promise<StoreFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(await storePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoreFile;
    cache = {
      version: 1,
      targets: parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {},
    };
  } catch {
    cache = { version: 1, targets: {} };
  }
  return cache;
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void persistNow();
  }, 250);
}

async function persistNow(): Promise<void> {
  if (!cache) return;
  try {
    await writeFile(await storePath(), JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    // ignore
  }
}

export async function loadReplyTargetsInto(
  store: Map<string, XbotReplyTarget>,
): Promise<number> {
  const file = await load();
  let n = 0;
  for (const [key, target] of Object.entries(file.targets)) {
    if (!key || !target?.route?.to) continue;
    store.set(key, target);
    n += 1;
  }
  return n;
}

export async function persistReplyTarget(
  sessionKey: string,
  target: XbotReplyTarget,
): Promise<void> {
  const key = sessionKey.trim();
  if (!key) return;
  const file = await load();
  file.targets[key] = target;
  // 简单上限，防止无限涨
  const keys = Object.keys(file.targets);
  if (keys.length > 400) {
    for (const drop of keys.slice(0, keys.length - 400)) {
      delete file.targets[drop];
    }
  }
  scheduleSave();
}
