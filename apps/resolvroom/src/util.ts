import { existsSync, realpathSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { alwaysDenyPatterns, globToRegExp, normalizePath } from "@resolvroom/protocol";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Set by wizards that already read stdin line by line, so nested prompts share it instead of opening a second reader. */
  reader?: LineReader;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** "30m", "8h", "2d" -> milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(m|h|d)$/.exec(text.trim());
  if (!m) throw new UsageError(`invalid duration "${text}" (use 30m, 8h or 2d)`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"];
  return n * unit;
}

export async function confirm(io: Io, question: string): Promise<boolean> {
  if (io.reader) return io.reader.yesNo(io, question, false);
  if (!io.isTTY) return false;
  io.out(`${question} [y/N] `);
  const rl = createInterface({ input: io.stdin, terminal: false });
  const answer = await new Promise<string>((resolve) => {
    rl.once("line", resolve);
    rl.once("close", () => resolve(""));
  });
  rl.close();
  return /^\s*(y|yes|s|sim)\s*$/i.test(answer);
}

import { parseArgs } from "node:util";

export function opts<T extends Record<string, { type: "string" | "boolean"; multiple?: boolean; short?: string }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, allowNegative: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** One readline for a whole wizard, so lines typed (or piped) ahead of time are not lost between questions. */
export class LineReader {
  private readonly rl;
  private readonly queue: string[] = [];
  private readonly waiters: Array<(line: string | null) => void> = [];
  private closed = false;

  constructor(input: NodeJS.ReadableStream) {
    this.rl = createInterface({ input, terminal: false });
    this.rl.on("line", (line) => {
      const w = this.waiters.shift();
      if (w) w(line);
      else this.queue.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  /** Prints the prompt and waits for one line. Returns null if the input ended. */
  ask(io: Io, prompt: string): Promise<string | null> {
    io.out(prompt);
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async yesNo(io: Io, question: string, def: boolean): Promise<boolean> {
    const a = await this.ask(io, `${question} [${def ? "Y/n" : "y/N"}] `);
    if (a === null || a.trim() === "") return def;
    return /^\s*(y|yes|s|sim)\s*$/i.test(a);
  }

  close(): void {
    this.rl.close();
  }
}

/**
 * Why a folder cannot be the agent's working folder, or null when it is fine. The Claude Code runner refuses
 * "/", the home folder itself and anything on the hard deny list, so the daemon would reject every request.
 */
export function workdirProblem(dir: string, home: string): string | null {
  const abs = resolve(dir);
  if (!existsSync(abs)) return `${abs} does not exist`;
  if (!statSync(abs).isDirectory()) return `${abs} is not a folder`;
  const real = normalizePath(realpathSync(abs));
  if (real === "/") return "the whole disk (/) cannot be shared";
  if (real === normalizePath(realpathSync(home))) return `your whole home folder (${real}) cannot be shared; pick a project folder inside it`;
  if (alwaysDenyPatterns(home).some((g) => globToRegExp(g).test(real))) return `${real} holds secrets or system files and is always denied`;
  return null;
}
