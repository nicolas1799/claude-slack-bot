import "dotenv/config";
import { readdirSync, statSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { App } from "@slack/bolt";
import { streamClaude, abortIfRunning } from "./claude.js";
import {
  parseCommand,
  setDirectory,
  getDirectory,
  getSessionKey,
  getDirectoryKey,
} from "./directories.js";
import {
  extractText,
  formatForSlack,
  splitMessage,
  textToBlocks,
} from "./format.js";
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
const SLACK_BLOCK_LIMIT = 2900;

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

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".ogg", ".webm", ".flac", ".aac", ".mp4"];

function isAudioFile(filename: string): boolean {
  return AUDIO_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext));
}

function transcribeAudio(filePath: string): string | null {
  try {
    console.log(`[whisper] Transcribing: ${filePath}`);
    const outputDir = join(TMP_DIR, "whisper-out");
    mkdirSync(outputDir, { recursive: true });
    execSync(
      `python3 -m whisper "${filePath}" --model small --language es --output_format txt --output_dir "${outputDir}"`,
      { timeout: 180000 }
    );
    // Whisper outputs a .txt file with the same name
    const baseName = filePath.split("/").pop()!.replace(/\.[^.]+$/, "");
    const txtPath = join(outputDir, `${baseName}.txt`);
    const transcript = readFileSync(txtPath, "utf-8").trim();
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
        const transcript = transcribeAudio(filePath);
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
app.message(async ({ message, say, client }) => {
  const msg = message as any;
  // Allow file_share subtype, ignore others
  if (msg.subtype && msg.subtype !== "file_share") return;
  if (msg.bot_id) return;

  let text = msg.text?.trim() || "";
  const channelId = msg.channel;
  const userId = msg.user;
  const threadTs = msg.thread_ts;

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
  let text = (event.text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim();

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

const PROCESSING_PHRASES = [
  "Processing...",
  "Exploring the codebase...",
  "Reading files...",
  "Analyzing the code...",
  "Putting it all together...",
  "Almost there...",
];

function buildProcessingBlocks(status: string): any[] {
  return [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `_${status}_`,
        },
      ],
    },
  ];
}

async function handleMessage({ text, channelId, userId, threadTs, ts, say, client }: HandleMessageParams) {
  const sessionKey = getSessionKey(channelId, threadTs, userId);
  const dirKey = getDirectoryKey(channelId, threadTs, userId);

  // Handle cwd commands
  const command = parseCommand(text);
  if (command) {
    if (command.type === "get") {
      const dir = getDirectory(channelId, threadTs, userId);
      const response = dir
        ? `Working directory: \`${dir}\``
        : "No working directory set. Use `cwd <repo-name>` to set one.";
      await say({ text: response, thread_ts: threadTs || ts });
      return;
    }

    const result = setDirectory(dirKey, command.path, BASE_DIRECTORY);
    const response = result.ok
      ? `Working directory set: \`${result.resolved}\``
      : result.error;
    await say({ text: response, thread_ts: threadTs || ts });
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
        return;
      }
      // Multiple repos — prepend context to the prompt so Claude picks the right one
      const repoList = repos.map((r) => `- ${r}`).join("\n");
      text = `[SYSTEM: Available repos in ${BASE_DIRECTORY}:\n${repoList}\n\nThe user has NOT selected a working directory yet. Based on their message, pick the most relevant repo and use cwd to set it before answering. If unclear, ask which repo they mean.]\n\nUser message: ${text}`;
      cwd = BASE_DIRECTORY;
    }
  }

  // Post initial processing message with context block
  const thinkingResponse = await client.chat.postMessage({
    channel: channelId,
    text: "Processing...",
    blocks: buildProcessingBlocks("Processing..."),
    thread_ts: threadTs || ts,
  });

  const messageTs = thinkingResponse.ts!;
  let accumulatedText = "";
  let lastUpdate = 0;
  let statusIndex = 0;
  const UPDATE_INTERVAL = 1500;

  let lastAssistantText = "";
  let gotResult = false;

  try {
    for await (const message of streamClaude(text, cwd, sessionKey)) {
      const now = Date.now();

      if (message.type === "assistant") {
        const newText = extractText(message as SDKAssistantMessage);
        if (newText) {
          lastAssistantText = newText;
          accumulatedText = newText;
        }

        // Update with debounce
        if (now - lastUpdate >= UPDATE_INTERVAL) {
          lastUpdate = now;
          statusIndex++;
          const status = PROCESSING_PHRASES[statusIndex % PROCESSING_PHRASES.length];

          if (accumulatedText) {
            // Show text + processing indicator so user knows it's still working
            await updateWithProcessing(client, channelId, messageTs, accumulatedText, status);
          } else {
            // No text yet, just show processing
            try {
              await client.chat.update({
                channel: channelId,
                ts: messageTs,
                text: status,
                blocks: buildProcessingBlocks(status),
              });
            } catch (_) {}
          }
        }
      }

      if (message.type === "result") {
        gotResult = true;
        const result = message as any;
        if (result.subtype === "error_result") {
          accumulatedText += `\n\n:x: Error: ${result.error || "Unknown error"}`;
        }
        if (result.result) {
          accumulatedText = result.result;
        }
      }
    }

    // Final update
    if (accumulatedText) {
      await sendFinalResponse(client, channelId, messageTs, threadTs || ts, accumulatedText);
      // Send a short new message to trigger notification
      try {
        await client.chat.postMessage({
          channel: channelId,
          text: ":white_check_mark: Done.",
          thread_ts: threadTs || ts,
        });
      } catch (_) {}
    } else {
      await updateSlackMessage(client, channelId, messageTs, ":warning: No response received.");
    }
  } catch (error: any) {
    console.error("Error in Claude query:", error);
    const errorText = error.name === "AbortError"
      ? ":stop_sign: Cancelled."
      : `:x: Error: ${error.message || "Unknown error"}`;
    await updateSlackMessage(client, channelId, messageTs, errorText);
  }
}

async function updateWithProcessing(
  client: any,
  channel: string,
  ts: string,
  text: string,
  status: string,
) {
  try {
    const formatted = formatForSlack(text);
    const truncated = formatted.length > SLACK_BLOCK_LIMIT
      ? formatted.slice(0, SLACK_BLOCK_LIMIT - 50) + "\n..."
      : formatted;
    await client.chat.update({
      channel,
      ts,
      text: truncated,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: truncated } },
        { type: "context", elements: [{ type: "mrkdwn", text: `_${status}_` }] },
      ],
    });
  } catch (e: any) {
    console.error("Failed to update message with processing:", e.message);
  }
}

async function updateSlackMessage(
  client: any,
  channel: string,
  ts: string,
  text: string,
) {
  try {
    const formatted = formatForSlack(text);
    // Always use blocks for proper mrkdwn rendering
    // Truncate to fit within a single block during streaming
    const truncated = formatted.length > SLACK_BLOCK_LIMIT
      ? formatted.slice(0, SLACK_BLOCK_LIMIT - 50) + "\n\n_...writing..._"
      : formatted;
    await client.chat.update({
      channel,
      ts,
      text: truncated,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: truncated } }],
    });
  } catch (e: any) {
    console.error("Failed to update Slack message:", e.message);
  }
}

async function sendFinalResponse(
  client: any,
  channel: string,
  messageTs: string,
  threadTs: string,
  text: string
) {
  const chunks = splitMessage(formatForSlack(text));

  // Update the original message with the first chunk
  const firstFormatted = formatForSlack(chunks[0]);
  try {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: firstFormatted,
      blocks: textToBlocks(firstFormatted),
    });
  } catch (e: any) {
    console.error("Failed to update final message:", e.message);
  }

  // Post additional chunks as new messages in the thread
  for (let i = 1; i < chunks.length; i++) {
    try {
      await client.chat.postMessage({
        channel,
        text: chunks[i],
        blocks: textToBlocks(chunks[i]),
        thread_ts: threadTs,
      });
    } catch (e: any) {
      console.error("Failed to post continuation message:", e.message);
    }
  }
}

// Start the app
(async () => {
  await app.start();
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id;
  console.log(`Bot is running! (user: ${botUserId})`);
  console.log(`Base directory: ${BASE_DIRECTORY}`);
})();
