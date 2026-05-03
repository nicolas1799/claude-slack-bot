import { Firestore } from "@google-cloud/firestore";

const db = new Firestore();

const SESSIONS = "bot_sessions";
const DIRECTORIES = "bot_directories";

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

export function logAudit(entry: AuditEntry): void {
  db.collection(AUDIT)
    .add(entry)
    .catch((e) => console.error(`[firestore] logAudit failed:`, e.message));
}
