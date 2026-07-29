import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

let ensured = false;

/** 持久化目录：~/.openclaw/xbot */
export function resolveXbotStateDir(): string {
  const override = process.env.OPENCLAW_XBOT_STATE_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(homedir(), '.openclaw', 'xbot');
}

export async function ensureXbotStateDir(): Promise<string> {
  const dir = resolveXbotStateDir();
  if (!ensured) {
    await mkdir(dir, { recursive: true });
    ensured = true;
  }
  return dir;
}
