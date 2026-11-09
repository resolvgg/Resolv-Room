#!/usr/bin/env node
import { main } from "./cli.js";

const code = await main(process.argv.slice(2), {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  stdin: process.stdin,
  isTTY: Boolean(process.stdin.isTTY),
  env: process.env,
  cwd: process.cwd(),
});
process.exit(code);
