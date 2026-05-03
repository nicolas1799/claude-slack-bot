import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();

const SESSIONS = "bot_sessions";
const DIRECTORIES = "bot_directories";
const COSTS = "bot_costs";
const JOBS = "bot_jobs";

export interface PersistedSession {
  sessionId: string;
  lastActivity: number;
}

export interface PersistedDirectory {
  cwd: string;
  updatedAt: number;
}

export async function loadAllSessions(maxAgeMs: number): Promise<Map<string, PersistedSession>> {
  const result = new Map<string, PersistedSession>();
  try {
    const snap = await db.collection(SESSIONS).get();
    const cutoff = Date.now() - maxAgeMs;
    const stale: string[] = [];
    snap.forEach((doc) => {
      const data = doc.data() as PersistedSession;
      if (data.lastActivity && data.lastActivity >= cutoff && data.sessionId) {
        result.set(doc.id, data);
      } else {
        stale.push(doc.id);
      }
    });
    if (stale.length > 0) {
      const batch = db.batch();
      for (const id of stale) batch.delete(db.collection(SESSIONS).doc(id));
      await batch.commit();
      console.log(`[firestore] Pruned ${stale.length} stale sessions`);
    }
  } catch (e: any) {
    console.error(`[firestore] loadAllSessions failed:`, e.message);
  }
  return result;
}

export async function loadAllDirectories(): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const snap = await db.collection(DIRECTORIES).get();
    snap.forEach((doc) => {
      const data = doc.data() as PersistedDirectory;
      if (data.cwd) result.set(doc.id, data.cwd);
    });
  } catch (e: any) {
    console.error(`[firestore] loadAllDirectories failed:`, e.message);
  }
  return result;
}

export function saveSession(key: string, sessionId: string): void {
  db.collection(SESSIONS)
    .doc(key)
    .set({ sessionId, lastActivity: Date.now() })
    .catch((e) => console.error(`[firestore] saveSession ${key} failed:`, e.message));
}

export function deleteSession(key: string): void {
  db.collection(SESSIONS)
    .doc(key)
    .delete()
    .catch((e) => console.error(`[firestore] deleteSession ${key} failed:`, e.message));
}

export function saveDirectory(key: string, cwd: string): void {
  db.collection(DIRECTORIES)
    .doc(key)
    .set({ cwd, updatedAt: Date.now() })
    .catch((e) => console.error(`[firestore] saveDirectory ${key} failed:`, e.message));
}

const AUDIT = "bot_tool_audit";

export interface AuditEntry {
  conversationKey: string;
  tool: string;
  summary: string;
  ok: boolean;
  durationMs?: number;
  error?: string;
  ts: number;
}

export interface PersistedCost {
  totalUsd: number;
  turnCount: number;
  lastTurnUsd: number;
  lastTurnAt: number;
}

export async function loadAllCosts(): Promise<Map<string, PersistedCost>> {
  const result = new Map<string, PersistedCost>();
  try {
    const snap = await db.collection(COSTS).get();
    snap.forEach((doc) => {
      const data = doc.data() as PersistedCost;
      if (typeof data.totalUsd === "number") result.set(doc.id, data);
    });
  } catch (e: any) {
    console.error(`[firestore] loadAllCosts failed:`, e.message);
  }
  return result;
}

export function saveCost(key: string, cost: PersistedCost): void {
  db.collection(COSTS)
    .doc(key)
    .set(cost)
    .catch((e) => console.error(`[firestore] saveCost ${key} failed:`, e.message));
}

export interface PersistedJob {
  jobId: string;
  channelId: string;
  threadTs: string;
  sessionKey: string;
  cwd: string;
  intervalMs: number;
  prompt: string;
  oneShot: boolean;
  nextRunAt: number;
  createdAt: number;
  createdBy?: string;
  runs: number;
}

export async function loadAllJobs(): Promise<Map<string, PersistedJob>> {
  const result = new Map<string, PersistedJob>();
  try {
    const snap = await db.collection(JOBS).get();
    snap.forEach((doc) => {
      const data = doc.data() as PersistedJob;
      if (data.jobId) result.set(doc.id, data);
    });
  } catch (e: any) {
    console.error(`[firestore] loadAllJobs failed:`, e.message);
  }
  return result;
}

export function saveJob(job: PersistedJob): void {
  db.collection(JOBS)
    .doc(job.jobId)
    .set(job)
    .catch((e) => console.error(`[firestore] saveJob ${job.jobId} failed:`, e.message));
}

export function deleteJob(jobId: string): void {
  db.collection(JOBS)
    .doc(jobId)
    .delete()
    .catch((e) => console.error(`[firestore] deleteJob ${jobId} failed:`, e.message));
}

export function logAudit(entry: AuditEntry): void {
  db.collection(AUDIT)
    .add(entry)
    .catch((e) => console.error(`[firestore] logAudit failed:`, e.message));
}
