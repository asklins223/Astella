import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = readFileSync(new URL("../deploy.sh", import.meta.url), "utf8");
const pruning = source.slice(source.indexOf("required_free_kb="), source.indexOf("# Root-only local preflight"));
assert.ok(pruning.includes("rm -rf"), "exercise the actual deployment pruning block");
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function exercise(local) {
  const root = mkdtempSync(join(tmpdir(), "astella-deploy-retention-"));
  try {
    const paths = ["newest", "recent", "third", "incoming-with-old-mtime", "current-with-old-mtime", "stale"]
      .map(name => join(root, "releases", name));
    paths.forEach(path => mkdirSync(path, { recursive: true }));
    const calls = join(root, "docker-calls");
    // Controlled find output reproduces copytree preserving an old directory
    // mtime; the actual shell pruning code still sorts and removes real files.
    const findOutput = paths.map((path, index) => `${100 - index} ${path}`).join("\n");
    const harness = `set -euo pipefail
release=${quote(paths[3])}
docker() { printf '%s\\n' "$*" >> ${quote(calls)}; }
find() { printf '%s\\n' ${quote(findOutput)}; }
readlink() { printf '%s\\n' ${quote(paths[4])}; }
df() { printf 'Filesystem blocks used available capacity mount\\nfixture 9999999 1 9999998 1%% /\\n'; }
${pruning.replaceAll("/opt/astella", root)}`;
    const result = spawnSync("bash", ["-c", harness, "deploy-test", "unused", ...(local ? ["--local-images"] : [])], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(paths[3]), "incoming release survives even with an old mtime");
    assert.ok(existsSync(paths[4]), "current rollback release survives");
    assert.equal(existsSync(paths[5]), false, "unprotected stale release is removed");
    assert.ok(paths.slice(0, 3).every(existsSync), "recent releases survive");
    return readFileSync(calls, "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("local image deployment retains its prepared images and incoming release", () => {
  const calls = exercise(true);
  assert.doesNotMatch(calls, /image prune/);
  assert.match(calls, /container prune/);
  assert.match(calls, /builder prune/);
});

test("registry deployment still prunes unused images while retaining incoming/current releases", () => {
  assert.match(exercise(false), /image prune -af/);
});
