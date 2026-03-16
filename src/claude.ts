import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";

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
    allowedTools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"],
    maxTurns: 25,
  };

  if (existingSession?.sessionId) {
    options.resume = existingSession.sessionId;
  }

  try {
    for await (const message of query({ prompt, options })) {
      // Capture session ID from system init message
      if (message.type === "system" && "session_id" in message) {
        const sessionId = (message as any).session_id;
        if (sessionId) {
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
  }
}
