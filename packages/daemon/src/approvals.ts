import { randomBytes } from "node:crypto";
import type { ApprovalRequest, Prompter } from "@resolvroom/core";
import type { Mode } from "@resolvroom/protocol";
import { sanitizeForTerminal } from "./prompter.js";

export interface PendingApproval {
  id: string;
  peer: string;
  session_id: string;
  goal: string;
  proposal: string;
  mode: Mode;
  access: string;
  timeout_s: number;
  expires_at: string;
}

export type AnswerResult = "ok" | "not_found" | "ambiguous";

/**
 * For daemons with no terminal (a VPS, a background service). Requests wait here until the owner answers with
 * `resolvroom approvals` / `approve` / `deny` on that machine. No answer in time means NO.
 */
export class QueuePrompter implements Prompter {
  private readonly pending = new Map<string, { info: PendingApproval; resolve: (a: "allow" | "deny") => void }>();

  approve(req: ApprovalRequest): Promise<"allow" | "deny"> {
    return new Promise((resolve) => {
      if (req.signal.aborted) return resolve("deny");
      const id = randomBytes(3).toString("hex");
      const info: PendingApproval = {
        id,
        peer: sanitizeForTerminal(req.peer, 100),
        session_id: req.sessionId,
        goal: sanitizeForTerminal(req.goal, 600),
        proposal: sanitizeForTerminal(req.proposal),
        mode: req.mode,
        access: sanitizeForTerminal(req.access, 400),
        timeout_s: req.timeoutS,
        expires_at: new Date(Date.now() + req.timeoutS * 1000).toISOString(),
      };
      this.pending.set(id, { info, resolve });
      req.signal.addEventListener(
        "abort",
        () => {
          this.pending.delete(id);
          resolve("deny");
        },
        { once: true },
      );
    });
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  /** `idPrefix` can be shortened as long as it is unambiguous. */
  answer(idPrefix: string, answer: "allow" | "deny"): AnswerResult {
    const matches = [...this.pending.keys()].filter((k) => k.startsWith(idPrefix.toLowerCase()));
    if (matches.length === 0 || idPrefix.length === 0) return "not_found";
    if (matches.length > 1) return "ambiguous";
    const id = matches[0] as string;
    const entry = this.pending.get(id);
    this.pending.delete(id);
    entry?.resolve(answer);
    return "ok";
  }
}
