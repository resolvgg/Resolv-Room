// The canonical schemas live in /spec/schemas. This package ships a copy so it is
// self-contained when published. Run automatically before build, typecheck and test.
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../../spec/schemas/", import.meta.url));
const target = fileURLToPath(new URL("../schemas/", import.meta.url));

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
