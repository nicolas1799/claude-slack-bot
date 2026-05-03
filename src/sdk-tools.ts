import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import os from "os";
import { statfsSync } from "fs";
import { getCostSummary, getTopCostConversations } from "./cost.js";

const botStartTime = Date.now();

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function safe<T>(fn: () => T, fallback: string): T | string {
  try {
    return fn();
  } catch (e: any) {
    return `${fallback}: ${e.message}`;
  }
}

const botStatus = tool(
  "bot_status",
  "Get this Slack bot's runtime status: uptime, # active sessions, # tracked working directories, memory.",
  {},
  async () => {
    const { sessionCount, directoryCount } = await getCounts();
    const uptimeSec = Math.floor((Date.now() - botStartTime) / 1000);
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    return ok(
      JSON.stringify(
        {
          uptime_sec: uptimeSec,
          memory_mb: memMb,
          active_sessions: sessionCount,
          tracked_directories: directoryCount,
          node: process.version,
          pid: process.pid,
        },
        null,
        2
      )
    );
  }
);

const vmMetrics = tool(
  "vm_metrics",
  "Get VM-level metrics: CPU load, memory, disk usage for /. Useful before deploys or when investigating perf.",
  {},
  async () => {
    const loadavg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const disk = safe(() => {
      const s = statfsSync("/");
      return {
        total_gb: +(s.blocks * s.bsize / 1e9).toFixed(2),
        free_gb: +(s.bavail * s.bsize / 1e9).toFixed(2),
      };
    }, "disk_unavailable");
    return ok(
      JSON.stringify(
        {
          loadavg_1_5_15: loadavg.map((n) => +n.toFixed(2)),
          mem_total_gb: +(totalMem / 1e9).toFixed(2),
          mem_free_gb: +(freeMem / 1e9).toFixed(2),
          mem_used_pct: +(((totalMem - freeMem) / totalMem) * 100).toFixed(1),
          disk_root: disk,
          uptime_sec: Math.floor(os.uptime()),
          hostname: os.hostname(),
        },
        null,
        2
      )
    );
  }
);

const serviceStatus = tool(
  "service_status",
  "Run `systemctl status` for a systemd unit (read-only). Returns active state and last log lines.",
  { unit: z.string().describe("systemd unit name, e.g. 'claude-slack-bot'") },
  async ({ unit }) => {
    const text = safe(
      () =>
        execSync(`systemctl status --no-pager -n 20 ${JSON.stringify(unit)}`, {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      "systemctl_failed"
    );
    return ok(typeof text === "string" ? text : String(text));
  }
);

const costStats = tool(
  "cost_stats",
  "Get bot Anthropic API cost stats: total spent across all conversations (persisted in Firestore), spend since current boot, and top conversations by cost.",
  { limit: z.number().int().positive().max(50).optional().describe("Max conversations to list (default 10)") },
  async ({ limit }) => {
    const summary = getCostSummary();
    const top = getTopCostConversations(limit ?? 10);
    return ok(JSON.stringify({ ...summary, top_conversations: top }, null, 2));
  }
);

let getCounts: () => Promise<{ sessionCount: number; directoryCount: number }> = async () => ({
  sessionCount: 0,
  directoryCount: 0,
});

export function registerCountsProvider(fn: typeof getCounts): void {
  getCounts = fn;
}

export const sdkToolsServer = createSdkMcpServer({
  name: "bot",
  version: "1.0.0",
  tools: [botStatus, vmMetrics, serviceStatus, costStats],
});

export const sdkToolNames = [
  "mcp__bot__bot_status",
  "mcp__bot__vm_metrics",
  "mcp__bot__service_status",
  "mcp__bot__cost_stats",
];
