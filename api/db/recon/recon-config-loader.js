import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REQUIRED = [
  "template_key",
  "expected.sql",
  "actual.sql",
  "match_keys",
  "amount_fields",
  "status_machine",
  "field_schema",
  "visibility_rules",
];

function getPath(obj, path) {
  return path.split(".").reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function validateConfig(config, templateKey) {
  const missing = REQUIRED.filter((key) => {
    const value = getPath(config, key);
    return value === undefined || value === null || value === "";
  });

  if (missing.length) {
    throw new Error(`Recon config ${templateKey} missing required keys: ${missing.join(", ")}`);
  }

  if (!Array.isArray(config.match_keys) || !config.match_keys.length) {
    throw new Error(`Recon config ${templateKey} match_keys must be a non-empty array`);
  }

  if (!Array.isArray(config.field_schema)) {
    throw new Error(`Recon config ${templateKey} field_schema must be an array`);
  }

  if (!Array.isArray(config.status_machine?.rules)) {
    throw new Error(`Recon config ${templateKey} status_machine.rules must be an array`);
  }

  return config;
}

export function loadConfig(templateKey) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(templateKey || ""))) {
    throw new Error("Invalid template key");
  }

  const baseDir = dirname(fileURLToPath(import.meta.url));
  const file = join(baseDir, "configs", `${templateKey}.json`);
  const raw = readFileSync(file, "utf8");
  const config = JSON.parse(raw);

  if (config.template_key !== templateKey) {
    throw new Error(`Recon config template_key mismatch: expected ${templateKey}, got ${config.template_key}`);
  }

  return validateConfig(config, templateKey);
}
