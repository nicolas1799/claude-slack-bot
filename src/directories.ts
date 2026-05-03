import { existsSync, statSync } from "fs";
import { resolve, join } from "path";
import { saveDirectory, loadAllDirectories } from "./firestore.js";

const directories = new Map<string, string>();

export async function hydrateDirectories(): Promise<void> {
  const persisted = await loadAllDirectories();
  for (const [key, cwd] of persisted) {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) {
      directories.set(key, cwd);
    }
  }
  console.log(`[firestore] Hydrated ${directories.size} directories`);
}

// Key for session management (can vary per thread)
export function getSessionKey(
  channelId: string,
  threadTs?: string,
  userId?: string
): string {
  // DMs: use channel-user (same session across threads in DM)
  if (channelId.startsWith("D")) return `${channelId}-${userId}`;
  // Threads in channels: per thread
  if (threadTs) return `${channelId}-${threadTs}`;
  // Channels: just channel
  return channelId;
}

// Key for directory lookup (stable, doesn't change with threads)
export function getDirectoryKey(
  channelId: string,
  threadTs?: string,
  userId?: string
): string {
  // DMs: always same directory per user-channel
  if (channelId.startsWith("D")) return `${channelId}-${userId}`;
  // Channels: check thread first, fall back to channel
  if (threadTs) return `${channelId}-${threadTs}`;
  return channelId;
}

export function parseCommand(text: string): { type: "set"; path: string } | { type: "get" } | null {
  const trimmed = text.trim();
  if (trimmed === "cwd") return { type: "get" };
  if (trimmed.startsWith("cwd ")) return { type: "set", path: trimmed.slice(4).trim() };
  return null;
}

export function setDirectory(
  key: string,
  inputPath: string,
  baseDir: string
): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolvedBase = resolve(baseDir);
  const resolved = inputPath.startsWith("/")
    ? resolve(inputPath)
    : resolve(join(resolvedBase, inputPath));

  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + "/")) {
    return { ok: false, error: `Directory must be under \`${resolvedBase}\`` };
  }

  if (!existsSync(resolved)) {
    return { ok: false, error: `Directory not found: \`${resolved}\`` };
  }

  if (!statSync(resolved).isDirectory()) {
    return { ok: false, error: `Not a directory: \`${resolved}\`` };
  }

  directories.set(key, resolved);
  saveDirectory(key, resolved);
  return { ok: true, resolved };
}

export function getDirectoriesCount(): number {
  return directories.size;
}

export function getDirectory(
  channelId: string,
  threadTs?: string,
  userId?: string
): string | undefined {
  const key = getDirectoryKey(channelId, threadTs, userId);
  const exact = directories.get(key);
  if (exact) return exact;

  // Fallback: for threads in channels, check the channel-level directory
  if (threadTs && !channelId.startsWith("D")) {
    return directories.get(channelId);
  }

  return undefined;
}
