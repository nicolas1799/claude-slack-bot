import "dotenv/config";
import { readdirSync, statSync, writeFileSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";
import { App } from "@slack/bolt";
import { streamClaude, hydrateSessions } from "./claude.js";
import { hydrateCosts, recordTurnCost } from "./cost.js";
import {
  parseCommand,
  setDirectory,
  getDirectory,
  getSessionKey,
  getDirectoryKey,
  hydrateDirectories,
} from "./directories.js";
import {
  extractText,
  formatForSlack,
  splitMessage,
  textToBlocks,
} from "./format.js";
import { resolveMentions } from "./mentions.js";
import { runWithRequestContext } from "./request-context.js";
import { hydrateJobs, bindSlackClient } from "./scheduler.js";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

// Validate required env vars
const required = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET", "BASE_DIRECTORY"];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const BASE_DIRECTORY = process.env.BASE_DIRECTORY!;

function listRepos(): string[] {
  try {
    return readdirSync(BASE_DIRECTORY)
      .filter((name) => {
        const full = join(BASE_DIRECTORY, name);
        return statSync(full).isDirectory() && !name.startsWith(".");
      });
  } catch {
    return [];
  }
}

function getDefaultCwd(): string | null {
  const repos = listRepos();
  if (repos.length === 1) return join(BASE_DIRECTORY, repos[0]);
  return null;
}

const TMP_DIR = "/tmp/slack-bot-files";
mkdirSync(TMP_DIR, { recursive: true });

const TMP_MAX_AGE_MS = 60 * 60 * 1000; // 1h
setInterval(() => {
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
  let removed = 0;
  try {
    for (const name of readdirSync(TMP_DIR)) {
      const full = join(TMP_DIR, name);
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
          removed++;
        }
      } catch {}
    }
    if (removed > 0) console.log(`[files] Cleaned ${removed} old tmp files`);
  } catch {}
}, 60 * 60 * 1000);

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".ogg", ".webm", ".flac", ".aac", ".mp4"];

function isAudioFile(filename: string): boolean {
  return AUDIO_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
}

async function transcribeAudio(filePath: string): Promise<string | null> {
  try {
    console.log(`[whisper] Transcribing via Groq: ${filePath}`);
    const formData = new FormData();
    const fileBuffer = readFileSync(filePath);
    const blob = new Blob([fileBuffer]);
    const fileName = filePath.split("/").pop() || "audio.m4a";
    formData.append("file", blob, fileName);
    formData.append("model", "whisper-large-v3");
    formData.append("language", "es");

    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      console.error(`[whisper] Groq API error: ${response.status} ${await response.text()}`);
      return null;
    }

    const result = await response.json() as any;
    const transcript = result.text?.trim() || "";
    console.log(`[whisper] Transcribed: ${transcript.slice(0, 100)}...`);
    return transcript;
  } catch (e: any) {
    console.error(`[whisper] Failed to transcribe:`, e.message);
    return null;
  }
}

interface ProcessedFile {
  path: string;
  type: "file" | "transcript";
  content?: string;
}

async function downloadSlackFiles(files: any[], token: string): Promise<ProcessedFile[]> {
  const results: ProcessedFile[] = [];
  for (const file of files) {
    try {
      const url = file.url_private_download || file.url_private;
      if (!url) continue;

      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) continue;

      const buffer = Buffer.from(await response.arrayBuffer());
      const filePath = join(TMP_DIR, `${Date.now()}-${file.name || "file"}`);
      writeFileSync(filePath, buffer);
      console.log(`[files] Downloaded: ${file.name} -> ${filePath}`);

      if (isAudioFile(file.name || "")) {
        const transcript = await transcribeAudio(filePath);
        if (transcript) {
          results.push({ path: filePath, type: "transcript", content: transcript });
        } else {
          results.push({ path: filePath, type: "file" });
        }
      } else {
        results.push({ path: filePath, type: "file" });
      }
    } catch (e: any) {
      console.error(`[files] Failed to download ${file.name}:`, e.message);
    }
  }
  return results;
}

function appendFileContext(text: string, files: ProcessedFile[]): string {
  const parts: string[] = [];
  const readFiles: string[] = [];

  for (const f of files) {
    if (f.type === "transcript") {
      parts.push(`[Audio transcription:\n${f.content}]`);
    } else {
      readFiles.push(f.path);
    }
  }

  if (readFiles.length > 0) {
    const fileList = readFiles.map((p) => `- ${p}`).join("\n");
    parts.push(`[The user attached files. Read them to analyze:\n${fileList}]`);
  }

  return `${text}\n\n${parts.join("\n\n")}`;
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

let botUserId: string | undefined;

// Handle DMs
function prettyToolStatus(name: string): string {
  if (name === "Bash") return "Ejecutando comando";
  if (name === "Read") return "Leyendo archivo";
  if (name === "Edit" || name === "Write") return "Editando archivo";
  if (name === "Grep" || name === "Glob") return "Buscando";
  if (name === "WebFetch") return "Consultando web";
  if (name === "WebSearch") return "Buscando en la web";
  if (name === "Task") return "Delegando a subagente";
  if (name === "TodoWrite") return "Actualizando tareas";
  if (name.startsWith("mcp__atlassian")) return "Consultando Atlassian";
  if (name.startsWith("mcp__supabase")) return "Consultando Supabase";
  if (name.startsWith("mcp__notebooklm")) return "Consultando NotebookLM";
  if (name.startsWith("mcp__stitch")) return "Generando diseño";
  if (name.startsWith("mcp__bot")) return "Revisando estado";
  if (name.startsWith("mcp__")) return "Llamando MCP";
  return name;
}

let statusDisabled = false;

async function setThreadStatus(
  client: any,
  channel: string,
  threadTs: string | undefined,
  status: string,
) {
  if (statusDisabled || !threadTs) return;
  try {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status,
    });
  } catch (e: any) {
    const code = e.data?.error || e.message || "";
    if (String(code).includes("missing_scope")) {
      console.warn(`[status] disabling setStatus permanently (${code})`);
      statusDisabled = true;
    } else if (String(code).includes("not_an_assistant_thread")) {
      // Channel/thread isn't an Assistant thread — silently skip, don't spam logs
    } else {
      console.error(`[status] setStatus failed: ${code}`);
    }
  }
}

async function addReaction(client: any, channel: string, timestamp: string, name: string) {
  try {
    await client.reactions.add({ name, channel, timestamp });
  } catch (e: any) {
    const code = e.data?.error || e.message || "";
    if (!String(code).includes("already_reacted")) {
      console.error(`[react] add ${name} failed: ${code}`);
    }
  }
}

async function removeReaction(client: any, channel: string, timestamp: string, name: string) {
  try {
    await client.reactions.remove({ name, channel, timestamp });
  } catch (e: any) {
    const code = e.data?.error || e.message || "";
    if (!String(code).includes("no_reaction")) {
      console.error(`[react] remove ${name} failed: ${code}`);
    }
  }
}

const REACT_THINKING = "hourglass_flowing_sand";
const REACT_DONE = "white_check_mark";
const REACT_ERROR = "x";
const REACT_CANCELLED = "double_vertical_bar";

app.message(async ({ message, say, client }) => {
  const msg = message as any;
  // Allow file_share subtype, ignore others
  if (msg.subtype && msg.subtype !== "file_share") return;
  if (msg.bot_id) return;

  let text = msg.text?.trim() || "";
  const channelId = msg.channel;
  const userId = msg.user;
  const threadTs = msg.thread_ts;

  text = await resolveMentions(client, text, botUserId);

  await addReaction(client, channelId, msg.ts, REACT_THINKING);

  // Download attached files
  if (msg.files && msg.files.length > 0) {
    const processed = await downloadSlackFiles(msg.files, process.env.SLACK_BOT_TOKEN!);
    if (processed.length > 0) {
      text = appendFileContext(text, processed);
    }
  }

  await handleMessage({ text, channelId, userId, threadTs, ts: msg.ts, say, client });
});

// Handle @mentions
app.event("app_mention", async ({ event, say, client }) => {
  let text = await resolveMentions(client, event.text || "", botUserId);

  await addReaction(client, event.channel, event.ts, REACT_THINKING);

  // Download attached files
  const eventFiles = (event as any).files;
  if (eventFiles && eventFiles.length > 0) {
    const processed = await downloadSlackFiles(eventFiles, process.env.SLACK_BOT_TOKEN!);
    if (processed.length > 0) {
      text = appendFileContext(text, processed);
    }
  }

  await handleMessage({
    text,
    channelId: event.channel,
    userId: event.user || "unknown",
    threadTs: event.thread_ts || event.ts,
    ts: event.ts,
    say,
    client,
  });
});

interface HandleMessageParams {
  text: string;
  channelId: string;
  userId: string;
  threadTs?: string;
  ts: string;
  say: any;
  client: any;
}

async function handleMessage({ text, channelId, userId, threadTs, ts, say, client }: HandleMessageParams) {
  const sessionKey = getSessionKey(channelId, threadTs, userId);
  const dirKey = getDirectoryKey(channelId, threadTs, userId);

  const finalize = async (reaction: string) => {
    await removeReaction(client, channelId, ts, REACT_THINKING);
    await addReaction(client, channelId, ts, reaction);
  };

  // Handle cwd commands
  const command = parseCommand(text);
  if (command) {
    if (command.type === "get") {
      const dir = getDirectory(channelId, threadTs, userId);
      const response = dir
        ? `Working directory: \`${dir}\``
        : "No working directory set. Use `cwd <repo-name>` to set one.";
      await say({ text: response, thread_ts: threadTs || ts });
      await finalize(REACT_DONE);
      return;
    }

    const result = setDirectory(dirKey, command.path, BASE_DIRECTORY);
    const response = result.ok
      ? `Working directory set: \`${result.resolved}\``
      : result.error;
    await say({ text: response, thread_ts: threadTs || ts });
    await finalize(result.ok ? REACT_DONE : REACT_ERROR);
    return;
  }

  // Check working directory (with fallback to channel-level, then auto-detect)
  let cwd = getDirectory(channelId, threadTs, userId);
  if (!cwd) {
    const defaultCwd = getDefaultCwd();
    if (defaultCwd) {
      // Only one repo — use it automatically
      cwd = defaultCwd;
      setDirectory(dirKey, defaultCwd, BASE_DIRECTORY);
    } else {
      const repos = listRepos();
      if (repos.length === 0) {
        await say({ text: "No repos found in `" + BASE_DIRECTORY + "`.", thread_ts: threadTs || ts });
        await finalize(REACT_ERROR);
        return;
      }
      // Multiple repos — prepend context to the prompt so Claude picks the right one
      const repoList = repos.map((r) => `- ${r}`).join("\n");
      text = `[SYSTEM: Available repos in ${BASE_DIRECTORY}:\n${repoList}\n\nThe user has NOT selected a working directory yet. Based on their message, pick the most relevant repo and use cwd to set it before answering. If unclear, ask which repo they mean.]\n\nUser message: ${text}`;
      cwd = BASE_DIRECTORY;
    }
  }

  let accumulatedText = "";
  const statusThreadTs = threadTs || ts;
  await setThreadStatus(client, channelId, statusThreadTs, "Pensando…");

  const ctxThreadTs = threadTs || ts;

  try {
    await runWithRequestContext({ channelId, threadTs: ctxThreadTs, sessionKey, cwd, userId }, async () => {
    for await (const message of streamClaude(text, cwd!, sessionKey)) {
      if (message.type === "assistant") {
        const content = (message as SDKAssistantMessage).message?.content || [];
        const toolUses = content.filter((b: any) => b.type === "tool_use");
        if (toolUses.length > 0) {
          const labels = Array.from(new Set(toolUses.map((t: any) => prettyToolStatus(t.name))));
          await setThreadStatus(client, channelId, statusThreadTs, `${labels.join(" · ")}…`);
        } else {
          await setThreadStatus(client, channelId, statusThreadTs, "Escribiendo respuesta…");
        }
        const newText = extractText(message as SDKAssistantMessage);
        if (newText) accumulatedText = newText;
        continue;
      }

      if (message.type === "result") {
        const result = message as any;
        if (result.subtype === "error_result") {
          accumulatedText += `\n\n:x: Error: ${result.error || "Unknown error"}`;
        }
        if (result.result) accumulatedText = result.result;
        if (result.modelUsage) {
          for (const [model, usage] of Object.entries(result.modelUsage as Record<string, any>)) {
            console.log(`[usage] ${model}: ${JSON.stringify(usage)}`);
          }
        }
        if (typeof result.total_cost_usd === "number") {
          console.log(`[usage] total_cost_usd=${result.total_cost_usd.toFixed(4)} duration_ms=${result.duration_ms || "?"}`);
          recordTurnCost(sessionKey, result.total_cost_usd);
        }
        continue;
      }

      if ((message as any).type === "rate_limit_event") {
        console.warn(`[ratelimit] ${JSON.stringify(message).slice(0, 200)}`);
        continue;
      }

      if ((message as any).type === "task_notification" || (message as any).type === "task_progress") {
        console.log(`[task] ${(message as any).type}: ${JSON.stringify(message).slice(0, 200)}`);
        continue;
      }
    }

    await setThreadStatus(client, channelId, statusThreadTs, "");
    if (accumulatedText) {
      await postFinalResponse(client, channelId, threadTs || ts, accumulatedText);
      await finalize(REACT_DONE);
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: ":warning: No response received.",
        thread_ts: threadTs || ts,
      });
      await finalize(REACT_ERROR);
    }
    });
  } catch (error: any) {
    console.error("Error in Claude query:", error);
    await setThreadStatus(client, channelId, statusThreadTs, "");
    const isAbort = error.name === "AbortError";
    const errorText = isAbort
      ? ":double_vertical_bar: Cancelado."
      : `:x: Error: ${error.message || "Unknown error"}`;
    await client.chat.postMessage({
      channel: channelId,
      text: errorText,
      thread_ts: threadTs || ts,
    });
    await finalize(isAbort ? REACT_CANCELLED : REACT_ERROR);
  }
}

async function postFinalResponse(
  client: any,
  channel: string,
  threadTs: string,
  text: string,
) {
  const chunks = splitMessage(formatForSlack(text));
  for (const chunk of chunks) {
    try {
      await client.chat.postMessage({
        channel,
        text: chunk,
        blocks: textToBlocks(chunk),
        thread_ts: threadTs,
      });
    } catch (e: any) {
      console.error("Failed to post response chunk:", e.message);
    }
  }
}

// SDK fires "Operation aborted" rejections from internal control_request handlers when a query
// is aborted mid-flight (e.g. abortIfRunning fires while an MCP tool call is in progress).
// Those rejections aren't awaited anywhere in user code, so without this handler Node 20 kills
// the process. Log everything else loudly so we don't swallow real bugs.
process.on("unhandledRejection", (reason: any) => {
  const msg = reason?.message || String(reason);
  if (msg.includes("Operation aborted")) {
    console.warn(`[unhandledRejection] swallowed expected abort: ${msg}`);
    return;
  }
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

// Start the app
(async () => {
  await Promise.all([hydrateSessions(), hydrateDirectories(), hydrateCosts()]);
  await app.start();
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;
  bindSlackClient(app.client);
  await hydrateJobs();
  console.log(`Bot is running! (user: ${botUserId})`);
  console.log(`Base directory: ${BASE_DIRECTORY}`);
})();
