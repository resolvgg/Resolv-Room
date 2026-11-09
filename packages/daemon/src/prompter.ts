import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { ApprovalRequest, Prompter } from "@resolvroom/core";

/** Removes ANSI escapes and control characters: the text comes from another machine and is untrusted. */
export function sanitizeForTerminal(text: string, maxChars = 1500): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b[\]P^_][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "");
  // eslint-disable-next-line no-control-regex
  const clean = noAnsi.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}… [truncated, ${clean.length} chars]` : clean;
}

export function formatApproval(req: ApprovalRequest): string {
  const indent = (s: string): string => s.split("\n").map((l) => `    ${l}`).join("\n");
  if (req.action) {
    return [
      "",
      "┌─ Resolv Room: the agent wants to read something outside the shared folder ─",
      `│ For:     ${sanitizeForTerminal(req.peer, 100)} (session ${sanitizeForTerminal(req.sessionId, 40)})`,
      `│ Tool:    ${sanitizeForTerminal(req.action.tool, 40)}`,
      `│ Path:    ${sanitizeForTerminal(req.action.target, 500)}`,
      "│ Goal:",
      indent(sanitizeForTerminal(req.goal, 600)),
      "│",
      req.action.tool === "Glob"
        ? "│ Allowing lets it list file NAMES under this folder (not their contents), for this session only."
        : "│ Allowing lets it read this one file, for this session only.",
      `│ No answer in ${req.timeoutS}s means NO.`,
      "└───────────────────────────────────────────────────────────────────",
    ].join("\n");
  }
  return [
    "",
    "┌─ Resolv Room: a remote agent wants your agent's help ─────────────",
    `│ From:    ${sanitizeForTerminal(req.peer, 100)}`,
    `│ Mode:    ${req.mode}`,
    `│ Access:  ${sanitizeForTerminal(req.access, 400)}`,
    "│ Goal:",
    indent(sanitizeForTerminal(req.goal, 600)),
    "│ Their proposal:",
    indent(sanitizeForTerminal(req.proposal)),
    "│",
    `│ No answer in ${req.timeoutS}s means NO.`,
    "└───────────────────────────────────────────────────────────────────",
  ].join("\n");
}

export interface TerminalPrompterOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Asks the human who runs this daemon, one prompt at a time, on the daemon's own terminal. */
export class TerminalPrompter implements Prompter {
  private queue: Promise<unknown> = Promise.resolve();
  private rl: Interface | undefined;

  constructor(private readonly o: TerminalPrompterOptions) {}

  approve(req: ApprovalRequest): Promise<"allow" | "deny"> {
    const run = (): Promise<"allow" | "deny"> => this.ask(req);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  close(): void {
    this.rl?.close();
  }

  private ask(req: ApprovalRequest): Promise<"allow" | "deny"> {
    return new Promise((resolve) => {
      if (req.signal.aborted) return resolve("deny");
      this.rl ??= createInterface({ input: this.o.input, terminal: false });
      const rl = this.rl;
      this.o.output.write(`${formatApproval(req)}\nAllow? [y/N] `);
      const finish = (answer: "allow" | "deny"): void => {
        rl.off("line", onLine);
        req.signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onLine = (line: string): void => finish(/^\s*(y|yes|s|sim)\s*$/i.test(line) ? "allow" : "deny");
      const onAbort = (): void => {
        this.o.output.write("\n(no answer in time: denied)\n");
        finish("deny");
      };
      rl.on("line", onLine);
      req.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

/** For daemons without a terminal (for example a background service): every ask is denied. */
export class DenyAllPrompter implements Prompter {
  async approve(): Promise<"deny"> {
    return "deny";
  }
}
