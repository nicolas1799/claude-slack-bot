import type { SDKMessage, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import slackify from "slackify-markdown";

const SLACK_BLOCK_MAX = 2900;

export function extractText(message: SDKAssistantMessage): string {
  if (!message.message?.content) return "";
  return message.message.content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("");
}

export function formatForSlack(text: string): string {
  return slackify(text);
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

    let splitAt = remaining.lastIndexOf("\n", SLACK_BLOCK_MAX);
    if (splitAt === -1 || splitAt < SLACK_BLOCK_MAX / 2) {
      splitAt = SLACK_BLOCK_MAX;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  return chunks;
}

// Parse markdown table lines into { headers, rows }
function parseMarkdownTable(lines: string[]): { headers: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null;

  const parseLine = (line: string) =>
    line.split("|").map((c) => c.trim()).filter((c) => c !== "");

  const headers = parseLine(lines[0]);
  if (headers.length === 0) return null;

  // Skip separator line (index 1)
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    if (cells.length > 0) rows.push(cells);
  }

  return { headers, rows };
}

// Convert parsed table to Slack table block (max 100 rows, 20 columns)
function markdownTableToSlackBlock(table: { headers: string[]; rows: string[][] }): any {
  const cols = table.headers.slice(0, 20);
  const dataRows = table.rows.slice(0, 99); // 99 data rows + 1 header = 100

  return {
    type: "table",
    rows: [
      // Header row
      cols.map((h) => ({ type: "raw_text", text: h })),
      // Data rows
      ...dataRows.map((row) =>
        cols.map((_, i) => ({ type: "raw_text", text: row[i] || "" }))
      ),
    ],
    column_settings: cols.map(() => ({
      align: "left",
      is_wrapped: true,
    })),
  };
}

// Convert text to blocks, extracting markdown tables into Slack table blocks
export function textToBlocks(text: string): any[] {
  const lines = text.split("\n");
  const blocks: any[] = [];
  let textBuffer: string[] = [];
  let tableLines: string[] = [];
  let inTable = false;

  const flushText = () => {
    if (textBuffer.length === 0) return;
    const content = textBuffer.join("\n").trim();
    if (content) {
      const chunks = splitMessage(content);
      for (const chunk of chunks) {
        blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
      }
    }
    textBuffer = [];
  };

  const flushTable = () => {
    if (tableLines.length === 0) return;
    const table = parseMarkdownTable(tableLines);
    if (table && table.rows.length > 0) {
      blocks.push(markdownTableToSlackBlock(table));
    } else {
      // Fallback: couldn't parse, add as code block
      textBuffer.push("```", ...tableLines, "```");
    }
    tableLines = [];
  };

  for (const line of lines) {
    const isTableLine = /^\s*\|/.test(line);
    const isSeparator = /^\s*\|[-:| ]+\|\s*$/.test(line);

    if (isTableLine || isSeparator) {
      if (!inTable) {
        flushText();
        inTable = true;
      }
      tableLines.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }
      textBuffer.push(line);
    }
  }

  // Flush remaining
  if (inTable) flushTable();
  flushText();

  // Slack has a 50 block limit
  return blocks.slice(0, 50);
}

export function describeMessage(message: SDKMessage): string | null {
  if (message.type === "assistant") {
    return extractText(message as SDKAssistantMessage);
  }
  return null;
}
