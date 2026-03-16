import type { SDKMessage, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

const SLACK_BLOCK_MAX = 2900; // section blocks have 3000 char limit, leave margin

export function extractText(message: SDKAssistantMessage): string {
  if (!message.message?.content) return "";
  return message.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
}

export function extractToolUse(message: SDKAssistantMessage): string | null {
  if (!message.message?.content) return null;
  const toolUses = message.message.content.filter(
    (block: any) => block.type === "tool_use"
  );
  if (toolUses.length === 0) return null;

  return toolUses
    .map((tool: any) => {
      const name = tool.name;
      if (name === "Read" || name === "FileRead") {
        return `Reading \`${tool.input?.file_path || "file"}\`...`;
      }
      if (name === "Edit" || name === "FileEdit") {
        return `Editing \`${tool.input?.file_path || "file"}\`...`;
      }
      if (name === "Write" || name === "FileWrite") {
        return `Writing \`${tool.input?.file_path || "file"}\`...`;
      }
      if (name === "Bash") {
        const cmd = tool.input?.command || "";
        const short = cmd.length > 60 ? cmd.slice(0, 60) + "..." : cmd;
        return `Running \`${short}\`...`;
      }
      if (name === "Grep") return `Searching for \`${tool.input?.pattern || "pattern"}\`...`;
      if (name === "Glob") return `Finding files \`${tool.input?.pattern || "pattern"}\`...`;
      return `Using ${name}...`;
    })
    .join("\n");
}

export function formatForSlack(text: string): string {
  // Process line by line, preserving code blocks
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    let formatted = line;

    // Headers: # Title → *Title*
    formatted = formatted.replace(/^#{1,6}\s+(.+)$/, "*$1*");

    // Bold: **text** → *text*
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, "*$1*");

    // Italic: _text_ stays the same in Slack
    // Strikethrough: ~~text~~ → ~text~
    formatted = formatted.replace(/~~(.+?)~~/g, "~$1~");

    // Links: [text](url) → <url|text>
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

    // Images: ![alt](url) → <url|alt>
    formatted = formatted.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

    result.push(formatted);
  }

  return result.join("\n");
}

export function splitMessage(text: string): string[] {
  if (text.length <= SLACK_BLOCK_MAX) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_BLOCK_MAX) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", SLACK_BLOCK_MAX);
    if (splitAt === -1 || splitAt < SLACK_BLOCK_MAX / 2) {
      splitAt = SLACK_BLOCK_MAX;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

// Build Slack blocks from text, splitting into multiple sections if needed
export function textToBlocks(text: string): any[] {
  const chunks = splitMessage(text);
  return chunks.map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk },
  }));
}

export function describeMessage(message: SDKMessage): string | null {
  if (message.type === "assistant") {
    return extractText(message as SDKAssistantMessage);
  }
  return null;
}
