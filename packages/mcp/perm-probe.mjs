import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
const log = process.env.PROBE_LOG;
const s = new McpServer({ name: "rrperm", version: "0" });
s.registerTool("approve", { description: "permission", inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() } }, async (args) => {
  fs.appendFileSync(log, JSON.stringify(args) + "\n");
  const allow = process.env.PROBE_ALLOW === "1";
  const r = allow ? { behavior: "allow", updatedInput: args.input } : { behavior: "deny", message: "denied by the owner of this machine" };
  return { content: [{ type: "text", text: JSON.stringify(r) }] };
});
await s.connect(new StdioServerTransport());
