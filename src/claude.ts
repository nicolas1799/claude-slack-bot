import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function loadMcpCredentials(): Record<string, { url: string; accessToken?: string }> {
  const credPath = join(process.env.HOME || "~", ".claude", ".credentials.json");
  if (!existsSync(credPath)) return {};

  try {
    const data = JSON.parse(readFileSync(credPath, "utf-8"));
    const mcpOAuth = data.mcpOAuth || {};
    const result: Record<string, { url: string; accessToken?: string }> = {};

    for (const [key, value] of Object.entries(mcpOAuth)) {
      const cred = value as any;
      if (cred.serverUrl && cred.accessToken) {
        // Extract server name from key like "plugin:atlassian:atlassian|hash"
        const name = cred.serverName?.split(":").pop() || key.split("|")[0];
        result[name] = { url: cred.serverUrl, accessToken: cred.accessToken };
      }
    }

    return result;
  } catch {
    return {};
  }
}

const mcpCredentials = loadMcpCredentials();
console.log(`[mcp] Loaded credentials for: ${Object.keys(mcpCredentials).join(", ") || "none"}`);

interface Session {
  sessionId?: string;
  lastActivity: number;
}

const sessions = new Map<string, Session>();
const activeAborts = new Map<string, AbortController>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

// Cleanup old sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      console.log(`[session] Expired: ${key}`);
      sessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

export function getSessionId(conversationKey: string): string | undefined {
  return sessions.get(conversationKey)?.sessionId;
}

export function abortIfRunning(conversationKey: string): void {
  const existing = activeAborts.get(conversationKey);
  if (existing) {
    existing.abort();
    activeAborts.delete(conversationKey);
  }
}

export async function* streamClaude(
  prompt: string,
  cwd: string,
  conversationKey: string
): AsyncGenerator<SDKMessage> {
  const existingSession = sessions.get(conversationKey);
  const abortController = new AbortController();

  // Abort any existing query for this conversation
  abortIfRunning(conversationKey);
  activeAborts.set(conversationKey, abortController);

  const options: Options = {
    cwd,
    abortController,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "mcp__atlassian", "mcp__supabase", "mcp__notebooklm-mcp", "mcp__stitch"],
    maxTurns: 25,
    settingSources: ["user", "project", "local"],
    plugins: [
      { type: "local" as const, path: join(process.env.HOME || "~", ".claude", "plugins", "cache", "atlassian", "atlassian", "1.0.0") },
    ],
    mcpServers: {
      "notebooklm-mcp": {
        command: join(process.env.HOME || "~", ".local", "bin", "notebooklm-mcp"),
        args: [] as string[],
      },
      ...Object.fromEntries(
        Object.entries(mcpCredentials)
          .filter(([name]) => name !== "atlassian") // Atlassian handled by plugin
          .map(([name, cred]) => [
            name,
            {
              type: "http" as const,
              url: cred.url,
              ...(cred.accessToken ? { headers: { Authorization: `Bearer ${cred.accessToken}` } } : {}),
            },
          ])
      ),
    },
  };

  if (existingSession?.sessionId) {
    options.resume = existingSession.sessionId;
    console.log(`[session] Resuming: ${conversationKey} -> ${existingSession.sessionId}`);
  } else {
    console.log(`[session] New session for: ${conversationKey}`);
  }

  try {
    for await (const message of query({ prompt, options })) {
      // Log message types for debugging
      if (message.type === "system") {
        console.log(`[sdk] system message:`, JSON.stringify(message).slice(0, 300));
      }

      if (message.type === "result") {
        console.log(`[sdk] result:`, JSON.stringify(message).slice(0, 300));
      }

      // Capture session ID - check multiple possible fields
      if (message.type === "system") {
        const msg = message as any;
        const sessionId = msg.session_id || msg.sessionId;
        if (sessionId) {
          console.log(`[session] Captured session ID: ${sessionId} for ${conversationKey}`);
          sessions.set(conversationKey, {
            sessionId,
            lastActivity: Date.now(),
          });
        }
      }

      // Also check result messages for session ID
      if (message.type === "result") {
        const msg = message as any;
        const sessionId = msg.session_id || msg.sessionId;
        if (sessionId) {
          console.log(`[session] Captured session ID from result: ${sessionId}`);
          sessions.set(conversationKey, {
            sessionId,
            lastActivity: Date.now(),
          });
        }
      }

      // Update activity timestamp
      const session = sessions.get(conversationKey);
      if (session) {
        session.lastActivity = Date.now();
      }

      yield message;
    }
  } finally {
    activeAborts.delete(conversationKey);
    const finalSession = sessions.get(conversationKey);
    console.log(`[session] Query done. Session for ${conversationKey}: ${finalSession?.sessionId || "none"}`);
  }
}
