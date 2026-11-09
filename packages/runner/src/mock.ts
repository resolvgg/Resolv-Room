import type { Capabilities, EffectivePermissions } from "@resolvroom/protocol";
import type { Runner, RunnerRequest, RunnerResult } from "@resolvroom/core";

export interface MockRunnerOptions {
  /** Name shown in answers. */
  name: string;
  /** Simulated work time in ms. Default 300. */
  delayMs?: number;
}

/** A runner that needs no AI and no tokens. Used for the local demo and for tests. */
export class MockRunner implements Runner {
  readonly agent = "claude-code";
  constructor(private readonly opts: MockRunnerOptions) {}

  async available(): Promise<boolean> {
    return true;
  }

  restrict(p: EffectivePermissions): Capabilities | null {
    return { read: p.capabilities.read, write: false, exec: false, network: false };
  }

  describeAccess(): string {
    return "none (mock agent: it only echoes, it touches no files)";
  }

  async run(req: RunnerRequest): Promise<RunnerResult> {
    await new Promise((r) => setTimeout(r, this.opts.delayMs ?? 300));
    if (req.signal.aborted) throw new Error("aborted");
    return {
      status: "solved",
      summary: [
        `[mock agent on ${this.opts.name}] I received a consultation from ${req.peer}.`,
        `Goal: ${req.goal}`,
        `Mode: ${req.permissions.mode}. Proposal received (${req.proposal.length} chars):`,
        req.proposal.length > 400 ? `${req.proposal.slice(0, 400)}…` : req.proposal,
        "Mock verdict: looks reasonable.",
      ].join("\n"),
    };
  }
}
