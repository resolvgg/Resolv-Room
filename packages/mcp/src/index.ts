import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ControlClient } from "@resolvroom/daemon";
import { createMcpServer } from "./server.js";

export * from "./room.js";
export * from "./server.js";

/** Runs the MCP server on stdio, talking to the local daemon through its control socket. */
export async function runStdioServer(socketPath: string): Promise<void> {
  const server = createMcpServer(new ControlClient(socketPath));
  await new Promise<void>((resolve, reject) => {
    server.server.onclose = () => resolve();
    // The client went away (stdin closed) without a proper shutdown: stop instead of hanging.
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
    server.server.onerror = () => undefined;
    server.connect(new StdioServerTransport()).catch(reject);
  });
}
