import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { execSync } from "child_process";
import os from "os";
import { statfsSync } from "fs";
import { getCostSummary, getTopCostConversations } from "./cost.js";
import { createJob, deleteJobById, listJobs, getActiveJobCount } from "./scheduler.js";
import { getRequestContext } from "./request-context.js";

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

const scheduleCreate = tool(
  "schedule_create",
  "Schedule a recurring (or one-shot) prompt to run in this same Slack thread. Use for 'every N minutes check X', 'remind me at...', polling for build/deploy completion. The scheduled prompt re-uses the current conversation session, so it has full context. When the watched condition is met (e.g. build finished), the scheduled run should call mcp__bot__schedule_delete with its jobId to stop. Cap: 10 active jobs total. Min interval 30s. Max interval 24h.",
  {
    intervalMinutes: z.number().positive().max(1440).describe("How often to run, in minutes. Min 0.5, max 1440 (24h)."),
    prompt: z.string().min(1).describe("The prompt to execute on each tick. Will be processed in this same thread/session."),
    oneShot: z.boolean().optional().describe("If true, run once after the interval and auto-delete. Default false (recurring)."),
  },
  async ({ intervalMinutes, prompt, oneShot }) => {
    const ctx = getRequestContext();
    if (!ctx) return ok(JSON.stringify({ error: "no request context — cannot schedule from outside a Slack-initiated query" }));
    const intervalMs = Math.round(intervalMinutes * 60 * 1000);
    const result = createJob({
      intervalMs,
      prompt,
      oneShot: !!oneShot,
      channelId: ctx.channelId,
      threadTs: ctx.threadTs,
      sessionKey: ctx.sessionKey,
      cwd: ctx.cwd,
      createdBy: ctx.userId,
    });
    if (!result.ok) return ok(JSON.stringify({ error: result.error }));
    return ok(
      JSON.stringify(
        {
          jobId: result.jobId,
          intervalMinutes,
          oneShot: !!oneShot,
          nextRunInSec: Math.round(intervalMs / 1000),
          activeJobs: getActiveJobCount(),
        },
        null,
        2
      )
    );
  }
);

const scheduleList = tool(
  "schedule_list",
  "List active scheduled jobs. Without args, lists jobs in the current thread. Set scope='all' to see jobs across the bot.",
  {
    scope: z.enum(["thread", "all"]).optional().describe("'thread' (default) limits to current thread, 'all' returns every active job"),
  },
  async ({ scope }) => {
    const ctx = getRequestContext();
    const filter = scope === "all" ? undefined : ctx ? { channelId: ctx.channelId, threadTs: ctx.threadTs } : undefined;
    const list = listJobs(filter);
    return ok(JSON.stringify({ count: list.length, jobs: list }, null, 2));
  }
);

const scheduleDelete = tool(
  "schedule_delete",
  "Stop and delete a scheduled job by its jobId. Call this when the watched condition is met (build done, deploy succeeded, etc.) or when the user asks to cancel.",
  {
    jobId: z.string().min(1).describe("The jobId returned by schedule_create"),
  },
  async ({ jobId }) => {
    const removed = deleteJobById(jobId);
    return ok(JSON.stringify({ ok: removed, jobId, message: removed ? "deleted" : "not found" }));
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
  tools: [botStatus, vmMetrics, serviceStatus, costStats, scheduleCreate, scheduleList, scheduleDelete],
});

export const sdkToolNames = [
  "mcp__bot__bot_status",
  "mcp__bot__vm_metrics",
  "mcp__bot__service_status",
  "mcp__bot__cost_stats",
  "mcp__bot__schedule_create",
  "mcp__bot__schedule_list",
  "mcp__bot__schedule_delete",
];
