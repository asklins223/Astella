#!/usr/bin/env node
/**
 * Scheduled dependency audit with an explicit, expiring allowlist.
 *
 * `npm audit` alone cannot distinguish "known and accepted until the major
 * upgrade lands" from "new high that nobody has looked at". This script reads
 * each package's lockfile-backed audit report, ignores workspace wrapper
 * entries (their `via` is a package name, not an advisory), and fails on any
 * high/critical advisory that is not allowlisted for the current date.
 *
 * Usage: node .github/scripts/security-audit.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const packages = [
  "packages/shared",
  "packages/agent-core",
  "packages/agent-host",
  "packages/ai-quality",
  "apps/api",
  "workers/ai-worker",
  "apps/desktop-client",
];

const allowlistPath = join(root, ".github/security-audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const now = Date.now();
let failed = false;

for (const [id, entry] of Object.entries(allowlist)) {
  const expiresAt = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    console.error(`[security-audit] allowlist entry ${id} is expired or has an invalid expiresAt (${entry.expiresAt})`);
    failed = true;
  }
}

function advisoryIds(vulnerability) {
  return (vulnerability.via ?? [])
    .filter((entry) => typeof entry === "object" && entry !== null)
    .map((entry) => {
      const match = String(entry.url ?? "").match(/GHSA-[a-z0-9-]+/i);
      return match?.[0] ?? null;
    });
}

for (const dir of packages) {
  let raw;
  try {
    raw = execFileSync("npm", ["audit", "--omit=dev", "--package-lock-only", "--json"], {
      cwd: join(root, dir),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    raw = error.stdout?.toString() ?? "";
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    console.error(`[security-audit] ${dir}: npm audit did not return JSON`);
    failed = true;
    continue;
  }

  const findings = [];
  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    if (!["high", "critical"].includes(vulnerability.severity)) continue;
    const ids = advisoryIds(vulnerability);
    // Workspace wrappers only point at another package; the real advisory is
    // reported on the underlying dependency and is evaluated there.
    if (ids.length === 0) continue;
    const open = ids.filter((id) => {
      const allowed = id && allowlist[id];
      return !allowed || Date.parse(allowed.expiresAt) <= now;
    });
    if (open.length > 0) {
      findings.push(`${name} (${vulnerability.severity}, ${open.join(", ")})`);
    }
  }

  if (findings.length === 0) {
    console.log(`[security-audit] ${dir}: OK`);
  } else {
    failed = true;
    console.error(`[security-audit] ${dir}: ${findings.length} unallowlisted high/critical advisory group(s)`);
    for (const finding of findings) console.error(`  - ${finding}`);
  }
}

if (failed) {
  console.error("[security-audit] FAILED");
  process.exit(1);
}
console.log("[security-audit] OK");