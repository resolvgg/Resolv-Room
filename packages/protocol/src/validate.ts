import { readFileSync } from "node:fs";
import AjvModule from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { DaemonConfig, Envelope, PermissionProfile } from "./types.js";

// Both packages are CommonJS; depending on the loader the constructor is the module itself or its `default`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Ajv: any = (AjvModule as any).default ?? AjvModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addFormats: any = (addFormatsModule as any).default ?? addFormatsModule;

const SCHEMA_FILES = ["common", "permission-profile", "config", "envelope"] as const;

function loadSchema(name: string): object {
  const url = new URL(`../schemas/${name}.schema.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as object;
}

const ajv = new Ajv({ strict: true, strictTypes: false, allowUnionTypes: true, allErrors: true });
addFormats(ajv);
for (const name of SCHEMA_FILES) {
  ajv.addSchema(loadSchema(name));
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

interface AjvError {
  instancePath: string;
  message?: string;
}

function makeValidator<T>(schemaId: string): (data: unknown) => ValidationResult<T> {
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`schema not registered: ${schemaId}`);
  }
  return (data: unknown): ValidationResult<T> => {
    if (validate(data)) {
      return { ok: true, value: data as T };
    }
    const errors = ((validate.errors ?? []) as AjvError[]).map(
      (e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`,
    );
    return { ok: false, errors };
  };
}

export const validateEnvelope = makeValidator<Envelope>("urn:resolvroom:0.1:envelope");
export const validatePermissionProfile = makeValidator<PermissionProfile>(
  "urn:resolvroom:0.1:permission-profile",
);
export const validateConfig = makeValidator<DaemonConfig>("urn:resolvroom:0.1:config");
