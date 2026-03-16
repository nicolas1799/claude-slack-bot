import "dotenv/config";
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
  extractToolUse,
  formatForSlack,
  splitMessage,
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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
});

let botUserId: string | undefined;

// Handle DMs
app.message(async ({ message, say, client }) => {
  if (message.subtype) return; // Ignore edits, joins, etc.
  const msg = message as any;
  if (msg.bot_id) return; // Ignore bot messages

  const text = msg.text?.trim() || "";
  const channelId = msg.channel;
  const userId = msg.user;
  const threadTs = msg.thread_ts;

  await handleMessage({ text, channelId, userId, threadTs, ts: msg.ts, say, client });
});

// Handle @mentions
app.event("app_mention", async ({ event, say, client }) => {
  const text = (event.text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim();

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

  // Check working directory (with fallback to channel-level)
  const cwd = getDirectory(channelId, threadTs, userId);
  if (!cwd) {
    await say({
      text: "No working directory set. Use `cwd <repo-name>` first.",
      thread_ts: threadTs || ts,
    });
    return;
  }

  // Post initial "thinking" message
  const thinkingResponse = await client.chat.postMessage({
    channel: channelId,
    text: ":hourglass_flowing_sand: Thinking...",
    thread_ts: threadTs || ts,
  });

  const messageTs = thinkingResponse.ts!;
  let accumulatedText = "";
  let lastUpdate = 0;
  const UPDATE_INTERVAL = 1500; // 1.5 seconds debounce

  try {
    for await (const message of streamClaude(text, cwd, sessionKey)) {
      if (message.type === "assistant") {
        const newText = extractText(message as SDKAssistantMessage);
        if (newText) {
          accumulatedText = newText;
          const now = Date.now();
          if (now - lastUpdate >= UPDATE_INTERVAL) {
            lastUpdate = now;
            await updateSlackMessage(client, channelId, messageTs, accumulatedText);
          }
        }

        const toolInfo = extractToolUse(message as SDKAssistantMessage);
        if (toolInfo && !newText) {
          const statusText = accumulatedText
            ? `${accumulatedText}\n\n_${toolInfo}_`
            : `_${toolInfo}_`;
          await updateSlackMessage(client, channelId, messageTs, statusText);
          lastUpdate = Date.now();
        }
      }

      if (message.type === "result") {
        const result = message as any;
        if (result.subtype === "error_result") {
          accumulatedText += `\n\n:x: Error: ${result.error || "Unknown error"}`;
        }
      }
    }

    // Final update
    if (accumulatedText) {
      await sendFinalResponse(client, channelId, messageTs, threadTs || ts, accumulatedText);
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

async function updateSlackMessage(
  client: any,
  channel: string,
  ts: string,
  text: string
) {
  try {
    const formatted = formatForSlack(text);
    await client.chat.update({
      channel,
      ts,
      text: formatted,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: formatted } }],
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
  await updateSlackMessage(client, channel, messageTs, chunks[0]);

  // Post additional chunks as new messages in the thread
  for (let i = 1; i < chunks.length; i++) {
    try {
      await client.chat.postMessage({
        channel,
        text: chunks[i],
        blocks: [{ type: "section", text: { type: "mrkdwn", text: chunks[i] } }],
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
