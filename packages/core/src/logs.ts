import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "@resolvroom/protocol";

export interface SessionLog {
  /** Appends one envelope and returns its position in this log (0-based). */
  append(envelope: Envelope, dir: "in" | "out"): number;
}

export interface DecisionEntry {
  session_id: string;
  peer: string;
  event: string;
  detail?: Record<string, unknown>;
}

/** Stores the append-only JSON Lines logs described in the protocol spec, section 8. */
export interface LogStore {
  session(sessionId: string): SessionLog;
  /** Local permission decisions. These are never sent to the other peer. */
  decision(entry: DecisionEntry): void;
}

const SAFE_ID = /^[A-Za-z0-9-]{1,64}$/;

class FileSessionLog implements SessionLog {
  private n = 0;
  constructor(private readonly file: string) {}

  append(envelope: Envelope, dir: "in" | "out"): number {
    const n = this.n++;
    appendFileSync(this.file, `${JSON.stringify({ n, dir, envelope })}\n`, { mode: 0o600 });
    return n;
  }
}

export class FileLogStore implements LogStore {
  private readonly sessionsDir: string;
  private readonly decisionsFile: string;
  private readonly cache = new Map<string, FileSessionLog>();

  constructor(logDir: string) {
    this.sessionsDir = join(logDir, "sessions");
    this.decisionsFile = join(logDir, "decisions.jsonl");
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
    chmodSync(logDir, 0o700);
  }

  session(sessionId: string): SessionLog {
    if (!SAFE_ID.test(sessionId)) throw new Error("unsafe session id");
    let log = this.cache.get(sessionId);
    if (!log) {
      log = new FileSessionLog(join(this.sessionsDir, `${sessionId}.jsonl`));
      this.cache.set(sessionId, log);
    }
    return log;
  }

  decision(entry: DecisionEntry): void {
    appendFileSync(this.decisionsFile, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, {
      mode: 0o600,
    });
  }
}

export class MemoryLogStore implements LogStore {
  readonly sessions = new Map<string, Array<{ n: number; dir: "in" | "out"; envelope: Envelope }>>();
  readonly decisions: DecisionEntry[] = [];

  session(sessionId: string): SessionLog {
    const rows = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, rows);
    return {
      append: (envelope, dir) => {
        const n = rows.length;
        rows.push({ n, dir, envelope });
        return n;
      },
    };
  }

  decision(entry: DecisionEntry): void {
    this.decisions.push(entry);
  }
}
