import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, Options } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { saveSession, deleteSession, loadAllSessions, logAudit } from "./firestore.js";
import { createBotServer, sdkToolNames, registerCountsProvider } from "./sdk-tools.js";
import { getDirectoriesCount } from "./directories.js";

function summarizeToolInput(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Bash") {
    const cmd = String(input.command || "");
    return cmd.length > 120 ? cmd.slice(0, 120) + "..." : cmd;
  }
  if (name === "Read" || name === "Edit" || name === "Write") {
    return String(input.file_path || "");
  }
  if (name === "Grep") return `pattern=${input.pattern || ""}`;
  if (name === "Glob") return `pattern=${input.pattern || ""}`;
  return JSON.stringify(input).slice(0, 120);
}

const toolStartTimes = new Map<string, number>();

function makeHooks(conversationKey: string): NonNullable<Options["hooks"]> {
  const preTool = async (input: any) => {
    if (input.hook_event_name === "PreToolUse") {
      const summary = summarizeToolInput(input.tool_name, input.tool_input);
      console.log(`[tool] ${input.tool_name} ${summary}`);
      if (input.tool_use_id) toolStartTimes.set(input.tool_use_id, Date.now());
    }
    return { continue: true };
  };

  const postTool = async (input: any) => {
    if (input.hook_event_name === "PostToolUse") {
      const start = input.tool_use_id ? toolStartTimes.get(input.tool_use_id) : undefined;
      const durationMs = start ? Date.now() - start : undefined;
      if (input.tool_use_id) toolStartTimes.delete(input.tool_use_id);
      logAudit({
        conversationKey,
        tool: input.tool_name,
        summary: summarizeToolInput(input.tool_name, input.tool_input),
        ok: true,
        durationMs,
        ts: Date.now(),
      });
    }
    return { continue: true };
  };

  const postToolFailure = async (input: any) => {
    if (input.hook_event_name === "PostToolUseFailure") {
      const start = input.tool_use_id ? toolStartTimes.get(input.tool_use_id) : undefined;
      const durationMs = start ? Date.now() - start : undefined;
      if (input.tool_use_id) toolStartTimes.delete(input.tool_use_id);
      console.error(`[tool] FAILED ${input.tool_name}: ${input.error || "unknown"}`);
      logAudit({
        conversationKey,
        tool: input.tool_name,
        summary: summarizeToolInput(input.tool_name, input.tool_input),
        ok: false,
        durationMs,
        error: String(input.error || "unknown"),
        ts: Date.now(),
      });
    }
    return { continue: true };
  };

  const userPromptSubmit = async (input: any) => {
    if (input.hook_event_name !== "UserPromptSubmit") return { continue: true };
    const ctx = buildTurnContext(input.cwd);
    if (!ctx) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit" as const,
        additionalContext: ctx,
      },
    };
  };

  const sessionStart = async (input: any) => {
    if (input.hook_event_name === "SessionStart") {
      console.log(`[session] start (source=${input.source || "?"}) key=${conversationKey}`);
    }
    return { continue: true };
  };

  const sessionEnd = async (input: any) => {
    if (input.hook_event_name === "SessionEnd") {
      console.log(`[session] end key=${conversationKey} reason=${input.reason || "?"}`);
    }
    return { continue: true };
  };

  const subagentStart = async (input: any) => {
    if (input.hook_event_name === "SubagentStart") {
      console.log(`[subagent] start id=${input.agent_id || "?"} type=${input.agent_type || "?"}`);
    }
    return { continue: true };
  };

  const subagentStop = async (input: any) => {
    if (input.hook_event_name === "SubagentStop") {
      console.log(`[subagent] stop id=${input.agent_id || "?"}`);
    }
    return { continue: true };
  };

  const notification = async (input: any) => {
    if (input.hook_event_name === "Notification") {
      console.log(`[notify] ${input.message || JSON.stringify(input)}`);
    }
    return { continue: true };
  };

  const preCompact = async (input: any) => {
    if (input.hook_event_name === "PreCompact") {
      console.log(`[compact] pre-compact for ${conversationKey}, transcript=${input.transcript_path || "?"}`);
    }
    return { continue: true };
  };

  return {
    PreToolUse: [{ hooks: [preTool] }],
    PostToolUse: [{ hooks: [postTool] }],
    PostToolUseFailure: [{ hooks: [postToolFailure] }],
    UserPromptSubmit: [{ hooks: [userPromptSubmit] }],
    SessionStart: [{ hooks: [sessionStart] }],
    SessionEnd: [{ hooks: [sessionEnd] }],
    SubagentStart: [{ hooks: [subagentStart] }],
    SubagentStop: [{ hooks: [subagentStop] }],
    Notification: [{ hooks: [notification] }],
    PreCompact: [{ hooks: [preCompact] }],
  };
}

function buildTurnContext(cwd?: string): string | null {
  const parts: string[] = [];
  parts.push(`Current date: ${new Date().toISOString().slice(0, 10)}`);
  if (cwd) {
    const branch = safeShell(`git -C ${shellQuote(cwd)} rev-parse --abbrev-ref HEAD`);
    const dirty = safeShell(`git -C ${shellQuote(cwd)} status --porcelain`);
    if (branch) parts.push(`Git branch: ${branch}`);
    if (dirty !== null) parts.push(`Working tree: ${dirty.trim() ? "dirty" : "clean"}`);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function memoryDirFor(cwd: string): string {
  const slug = cwd.replace(/^\//, "").replace(/\//g, "-");
  return join(process.env.HOME || "/root", ".claude", "projects", `-${slug}`, "memory");
}

function ensureMemoryDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e: any) {
    console.error(`[memory] ensureMemoryDir failed: ${e.message}`);
  }
}

function loadMemoryIndex(memDir: string): string {
  try {
    return readFileSync(join(memDir, "MEMORY.md"), "utf-8").trim();
  } catch {
    return "";
  }
}

function buildAutoMemoryBlock(memDir: string): string {
  const index = loadMemoryIndex(memDir);
  return [
    "",
    "# auto memory",
    "",
    `You have a persistent, file-based memory system at \`${memDir}\`. This directory already exists — write to it directly with the Write tool (do not run mkdir or check for its existence). Its contents persist across conversations.`,
    "",
    "Build up this memory over time so future conversations have context about who the user is, how to collaborate, and the work history.",
    "",
    "## Types of memory",
    "- **user**: who the user is, role, preferences, knowledge. Save when you learn something stable about them.",
    "- **feedback**: corrections or validated approaches. Save when the user corrects you OR confirms a non-obvious choice. Include why and how-to-apply.",
    "- **project**: ongoing work, goals, deadlines, who is doing what. Convert relative dates to absolute (\"Thursday\" → \"2026-05-08\").",
    "- **reference**: pointers to external systems (Linear projects, Grafana dashboards, internal docs).",
    "",
    "## How to save",
    "Two-step write:",
    "1. Write the memory to its own file (e.g., `user_role.md`) with frontmatter:",
    "```",
    "---",
    "name: <short name>",
    "description: <one-line specific description>",
    "type: user|feedback|project|reference",
    "---",
    "<body — for feedback/project, lead with the rule/fact, then **Why:** and **How to apply:** lines>",
    "```",
    "2. Add a one-line pointer to `MEMORY.md`: `- [Title](file.md) — one-line hook`. Keep `MEMORY.md` under 200 lines.",
    "",
    "## Don't save",
    "- Code patterns, architecture, file paths (derivable from git)",
    "- Debug fix recipes (lives in commits)",
    "- Ephemeral task state (use TodoWrite/plans instead)",
    "- Anything already in CLAUDE.md",
    "",
    "## When to read",
    "When memories seem relevant or the user references prior work. Verify with current code before acting on a memory — it can be stale. If conflict, trust the code and update the memory.",
    "",
    index
      ? `## Current MEMORY.md\n\`\`\`\n${index.slice(0, 4000)}\n\`\`\``
      : "## Current MEMORY.md\n(empty — start fresh)",
  ].join("\n");
}

const MEMORY_TRIGGER = /\b(record[aá]r?|recuerd[ao]|guard[aá]r?|memori[zc]|memori[ao]|olvid[aá]r?|olvidate|remember|memorize|forget|memory|memo)\b/i;

function buildSystemPromptAppend(cwd: string, prompt: string): string {
  const ops =
    "Sos un agente operativo corriendo en una VM GCP (us-central1, e2-medium) accedido vía Slack. " +
    "Respondé en español rioplatense, conciso. " +
    "Antes de operaciones destructivas (delete, force push, drop), confirmá explícitamente con el usuario. " +
    "Para info de la propia VM y del bot (CPU/mem/disco de la VM, sesiones activas, status del servicio systemd) usá los tools mcp__bot__* (vm_metrics, bot_status, service_status). " +
    "Para info y operaciones de GCP (proyectos, instancias, Cloud Run, Cloud SQL, Firestore, IAM, logs en Cloud Logging, etc.) usá `gcloud` vía Bash. Combiná ambos enfoques cuando haga falta. " +
    "Para deploys del propio bot: cd al cwd del repo, git pull, npx tsc, sudo systemctl restart claude-slack-bot. " +
    "Si el usuario pide chequeos recurrentes ('cada N minutos revisá X', 'avisame cuando termine Y', 'recordame en X minutos'), usá mcp__bot__schedule_create — corre prompts en este mismo thread cada intervalo. Cuando la condición a esperar se cumpla, el run programado debe llamar mcp__bot__schedule_delete con su jobId para parar. Para listar/cancelar: mcp__bot__schedule_list / schedule_delete. Cap 10 jobs activos, mín 30s, máx 24h. " +
    "Si el usuario pide guardar/recordar/olvidar algo (palabras como 'recordá', 'guardá', 'memoria', 'olvidá'), seguí las instrucciones de # auto memory que aparecen abajo.";

  if (!MEMORY_TRIGGER.test(prompt)) return ops;

  const memDir = memoryDirFor(cwd);
  ensureMemoryDir(memDir);
  return ops + "\n" + buildAutoMemoryBlock(memDir);
}

function safeShell(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).trim();
  } catch {
    return null;
  }
}

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

export const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min

registerCountsProvider(async () => ({
  sessionCount: sessions.size,
  directoryCount: getDirectoriesCount(),
}));

export async function hydrateSessions(): Promise<void> {
  const persisted = await loadAllSessions(SESSION_TTL_MS);
  for (const [key, value] of persisted) {
    sessions.set(key, { sessionId: value.sessionId, lastActivity: value.lastActivity });
  }
  console.log(`[firestore] Hydrated ${sessions.size} sessions`);
}

// Cleanup old sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      console.log(`[session] Expired: ${key}`);
      sessions.delete(key);
      deleteSession(key);
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
    model: "claude-opus-4-7",
    includePartialMessages: true,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    allowedTools: [
      "Read", "Edit", "Write", "Bash", "Grep", "Glob",
      "mcp__atlassian", "mcp__supabase", "mcp__notebooklm-mcp", "mcp__stitch",
      ...sdkToolNames,
    ],
    disallowedTools: [
      "Bash(gcloud projects delete:*)",
      "Bash(gcloud compute instances delete:*)",
      "Bash(gcloud sql instances delete:*)",
      "Bash(gcloud firestore databases delete:*)",
      "Bash(rm -rf /:*)",
      "Bash(rm -rf ~:*)",
      "Bash(rm -rf /*:*)",
      "Bash(sudo rm:*)",
    ],
    maxTurns: 25,
    additionalDirectories: (process.env.ADDITIONAL_DIRECTORIES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildSystemPromptAppend(cwd, prompt),
    },
    hooks: makeHooks(conversationKey),
    settingSources: ["user", "project", "local"],
    plugins: [
      { type: "local" as const, path: join(process.env.HOME || "~", ".claude", "plugins", "cache", "atlassian", "atlassian", "1.0.0") },
    ],
    mcpServers: {
      "notebooklm-mcp": {
        command: join(process.env.HOME || "~", ".local", "bin", "notebooklm-mcp"),
        args: [] as string[],
      },
      bot: createBotServer(),
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
          saveSession(conversationKey, sessionId);
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
          saveSession(conversationKey, sessionId);
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
