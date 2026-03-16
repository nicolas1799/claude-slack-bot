import { existsSync, statSync } from "fs";
import { resolve, join } from "path";

const directories = new Map<string, string>();

export function getConversationKey(
  channelId: string,
  threadTs?: string,
  userId?: string
): string {
  // DMs: use channel-user
  if (channelId.startsWith("D")) return `${channelId}-${userId}`;
  // Threads: use channel-thread
  if (threadTs) return `${channelId}-${threadTs}`;
  // Channels: just channel
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
  const resolved = inputPath.startsWith("/")
    ? inputPath
    : resolve(join(baseDir, inputPath));

  if (!existsSync(resolved)) {
    return { ok: false, error: `Directory not found: \`${resolved}\`` };
  }

  if (!statSync(resolved).isDirectory()) {
    return { ok: false, error: `Not a directory: \`${resolved}\`` };
  }

  directories.set(key, resolved);
  return { ok: true, resolved };
}

export function getDirectory(key: string): string | undefined {
  return directories.get(key);
}
