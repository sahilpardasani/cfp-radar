#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getActiveCFPs } from "../lib/cfp.js";

function outputPath(argv = process.argv.slice(2)) {
  const value = argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
  if (!value || value.length > 2_000) throw new Error("Provide a bounded --output=/path/to/file.json value.");
  const resolved = path.resolve(value);
  if (path.extname(resolved).toLowerCase() !== ".json") throw new Error("The conference baseline must be a JSON file.");
  return resolved;
}

export function currentConferenceIds(now = new Date()) {
  return [...new Set(
    getActiveCFPs(now).items
      .filter((call) => call.type === "conference")
      .map((call) => String(call.id || "").trim())
      .filter((id) => id && id.length <= 200)
  )].sort();
}

export function writeConferenceBaseline(filePath, conferenceIds, now = new Date()) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  const payload = {
    schemaVersion: 1,
    createdAt: now.toISOString(),
    conferenceIds,
  };
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filePath);
  return payload;
}

async function main() {
  const filePath = outputPath();
  const conferenceIds = currentConferenceIds();
  writeConferenceBaseline(filePath, conferenceIds);
  console.log(`Saved ${conferenceIds.length} active conference IDs before discovery.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export const __test = { outputPath };
