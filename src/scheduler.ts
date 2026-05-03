import { randomBytes } from "crypto";
import { streamClaude } from "./claude.js";
import { recordTurnCost } from "./cost.js";
import { extractText, formatForSlack, splitMessage, textToBlocks } from "./format.js";
import { saveJob, deleteJob, loadAllJobs, type PersistedJob } from "./firestore.js";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

const MIN_INTERVAL_MS = 30 * 1000; // 30s
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_ACTIVE_JOBS = 10;
const SCHEDULED_PROMPT_PREFIX = "[SCHEDULED RUN]";

interface ActiveJob {
  job: PersistedJob;
  timer: NodeJS.Timeout | null;
  running: boolean;
}

const jobs = new Map<string, ActiveJob>();
let slackClient: any = null;

export function bindSlackClient(client: any): void {
  slackClient = client;
}

export async function hydrateJobs(): Promise<void> {
  const persisted = await loadAllJobs();
  const now = Date.now();
  for (const [jobId, job] of persisted) {
    // Recompute next run: if missed, schedule asap (with 5s grace)
    const delay = Math.max(5000, job.nextRunAt - now);
    scheduleNext(job, delay);
  }
  console.log(`[scheduler] Hydrated ${jobs.size} jobs`);
}

function newJobId(): string {
  return randomBytes(4).toString("hex");
}

export interface CreateJobInput {
  intervalMs: number;
  prompt: string;
  oneShot: boolean;
  channelId: string;
  threadTs: string;
  sessionKey: string;
  cwd: string;
  createdBy?: string;
}

export function createJob(input: CreateJobInput): { ok: true; jobId: string } | { ok: false; error: string } {
  if (jobs.size >= MAX_ACTIVE_JOBS) {
    return { ok: false, error: `Max ${MAX_ACTIVE_JOBS} active jobs already running` };
  }
  if (input.intervalMs < MIN_INTERVAL_MS) {
    return { ok: false, error: `Interval too short (min ${MIN_INTERVAL_MS / 1000}s)` };
  }
  if (input.intervalMs > MAX_INTERVAL_MS) {
    return { ok: false, error: `Interval too long (max 24h)` };
  }
  if (!input.prompt.trim()) {
    return { ok: false, error: "prompt cannot be empty" };
  }

  const jobId = newJobId();
  const now = Date.now();
  const job: PersistedJob = {
    jobId,
    channelId: input.channelId,
    threadTs: input.threadTs,
    sessionKey: input.sessionKey,
    cwd: input.cwd,
    intervalMs: input.intervalMs,
    prompt: input.prompt,
    oneShot: input.oneShot,
    nextRunAt: now + input.intervalMs,
    createdAt: now,
    createdBy: input.createdBy,
    runs: 0,
  };

  saveJob(job);
  scheduleNext(job, input.intervalMs);
  console.log(`[scheduler] Created job ${jobId} every ${input.intervalMs}ms in ${input.channelId}/${input.threadTs}`);
  return { ok: true, jobId };
}

export function deleteJobById(jobId: string): boolean {
  const active = jobs.get(jobId);
  if (!active) return false;
  if (active.timer) clearTimeout(active.timer);
  jobs.delete(jobId);
  deleteJob(jobId);
  console.log(`[scheduler] Deleted job ${jobId}`);
  return true;
}

export function listJobs(filter?: { channelId?: string; threadTs?: string }) {
  const out: any[] = [];
  for (const { job } of jobs.values()) {
    if (filter?.channelId && job.channelId !== filter.channelId) continue;
    if (filter?.threadTs && job.threadTs !== filter.threadTs) continue;
    out.push({
      jobId: job.jobId,
      channelId: job.channelId,
      threadTs: job.threadTs,
      intervalMs: job.intervalMs,
      oneShot: job.oneShot,
      runs: job.runs,
      nextRunAt: new Date(job.nextRunAt).toISOString(),
      promptPreview: job.prompt.slice(0, 120),
    });
  }
  return out;
}

function scheduleNext(job: PersistedJob, delayMs: number): void {
  const existing = jobs.get(job.jobId);
  if (existing?.timer) clearTimeout(existing.timer);

  const timer = setTimeout(() => runJob(job.jobId).catch((e) =>
    console.error(`[scheduler] runJob ${job.jobId} threw:`, e?.message || e)
  ), delayMs);

  jobs.set(job.jobId, { job, timer, running: existing?.running || false });
}

async function runJob(jobId: string): Promise<void> {
  const active = jobs.get(jobId);
  if (!active) return;
  const { job } = active;

  if (active.running) {
    console.warn(`[scheduler] ${jobId} still running — skipping this tick`);
    if (!job.oneShot) {
      job.nextRunAt = Date.now() + job.intervalMs;
      saveJob(job);
      scheduleNext(job, job.intervalMs);
    }
    return;
  }

  active.running = true;
  console.log(`[scheduler] Running job ${jobId} (run #${job.runs + 1})`);

  try {
    if (!slackClient) {
      console.error(`[scheduler] No Slack client bound — skipping run`);
      return;
    }

    const augmentedPrompt =
      `${SCHEDULED_PROMPT_PREFIX} job=${jobId} run=${job.runs + 1} oneShot=${job.oneShot}\n` +
      `If the watched condition is met, call mcp__bot__schedule_delete with this jobId to stop further runs.\n\n` +
      job.prompt;

    let accumulated = "";
    let sawAssistant = false;

    for await (const message of streamClaude(augmentedPrompt, job.cwd, job.sessionKey)) {
      if (message.type === "assistant") {
        sawAssistant = true;
        const t = extractText(message as SDKAssistantMessage);
        if (t) accumulated = t;
        continue;
      }
      if (message.type === "result") {
        const r = message as any;
        if (r.result) accumulated = r.result;
        if (typeof r.total_cost_usd === "number") {
          recordTurnCost(job.sessionKey, r.total_cost_usd);
        }
        continue;
      }
    }

    if (accumulated || sawAssistant) {
      const chunks = splitMessage(formatForSlack(accumulated || "(scheduled run produced no text)"));
      for (const chunk of chunks) {
        try {
          await slackClient.chat.postMessage({
            channel: job.channelId,
            text: chunk,
            blocks: textToBlocks(chunk),
            thread_ts: job.threadTs,
          });
        } catch (e: any) {
          console.error(`[scheduler] postMessage failed for ${jobId}: ${e.message}`);
        }
      }
    }

    job.runs += 1;
  } catch (e: any) {
    console.error(`[scheduler] Job ${jobId} errored: ${e.message}`);
    try {
      await slackClient?.chat.postMessage({
        channel: job.channelId,
        text: `:x: Cron \`${jobId}\` falló: ${e.message || "unknown"}`,
        thread_ts: job.threadTs,
      });
    } catch {}
  } finally {
    active.running = false;
  }

  // Reschedule or finalize
  const stillActive = jobs.get(jobId);
  if (!stillActive) return; // was deleted during the run

  if (job.oneShot) {
    deleteJobById(jobId);
    return;
  }

  job.nextRunAt = Date.now() + job.intervalMs;
  saveJob(job);
  scheduleNext(job, job.intervalMs);
}

export function getActiveJobCount(): number {
  return jobs.size;
}
