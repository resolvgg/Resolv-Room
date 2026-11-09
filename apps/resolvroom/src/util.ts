import { createInterface } from "node:readline";

export interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  cwd: string;
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
