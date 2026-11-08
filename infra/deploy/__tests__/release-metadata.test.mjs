import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const workflow = readFileSync(join(repository, ".github/workflows/server-deploy.yml"), "utf8");
const step = workflow.split("      - name: Write image digests and release metadata\n")[1]?.split("      - name:")[0];
assert.ok(step, "exercise the actual CI step that creates the deployment environment");
const script = step.split("        run: |\n")[1].split("\n").map(line => line.replace(/^          /, "")).join("\n");
const commit = "1234567890abcdef1234567890abcdef12345678";
const digest = `sha256:${"a".repeat(64)}`;

test("CI release identity reaches both production containers through the deployment bundle", () => {
  const directory = mkdtempSync(join(tmpdir(), "astella-release-metadata-"));
  try {
    mkdirSync(join(directory, "release"));
    writeFileSync(join(directory, "release/version.json"), JSON.stringify({ version: "12.34.56" }));
    const env = {
      ...process.env,
      PREFIX: "ghcr.io/fixture/astella",
      API_DIGEST: digest, WORKER_DIGEST: digest, TTS_DIGEST: digest,
      EMBEDDING_DIGEST: digest, BACKUP_DIGEST: digest,
      GITHUB_SHA: commit,
      POSTGRES_PASSWORD: "fixture", MIGRATOR_PASSWORD: "fixture",
      API_PASSWORD: "fixture", WORKER_PASSWORD: "fixture",
      DATABASE_URL_MIGRATOR: "postgres://fixture:fixture@postgres/fixture",
      DATABASE_URL_API: "postgres://fixture:fixture@postgres/fixture",
      DATABASE_URL_WORKER: "postgres://fixture:fixture@postgres/fixture",
      EDGE_TTS_AUTH_TOKEN: "fixture",
      STORAGE_ENDPOINT: "https://storage.example.invalid",
      STORAGE_ACCESS_KEY_ID: "fixture", STORAGE_SECRET_ACCESS_KEY: "fixture",
    };
    // Metadata must come from the checked-out release and CI commit, rather
    // than stale operator environment values inherited by the runner.
    delete env.APP_VERSION;
    delete env.GIT_COMMIT;
    const written = spawnSync("bash", ["-c", script], { cwd: directory, env, encoding: "utf8" });
    assert.equal(written.status, 0, written.stderr);
    const environmentFile = join(directory, "deployment-images.env");
    const generated = Object.fromEntries(readFileSync(environmentFile, "utf8").trim().split("\n").map(line => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }));
    assert.equal(generated.APP_VERSION, "12.34.56");
    assert.equal(generated.GIT_COMMIT, commit);
    assert.equal(generated.API_IMAGE, `${env.PREFIX}-api@${digest}`);
    assert.equal(generated.WORKER_IMAGE, `${env.PREFIX}-worker@${digest}`);

    const rendered = spawnSync("docker", ["compose", "--project-directory", repository,
      "--env-file", environmentFile,
      "-f", resolve(repository, "docker-compose.yml"),
      "-f", resolve(repository, "docker-compose.deploy.yml"),
      "config", "--format", "json"], { env, encoding: "utf8" });
    assert.equal(rendered.status, 0, rendered.stderr);
    const compose = JSON.parse(rendered.stdout);
    for (const service of ["api", "worker"]) {
      assert.equal(compose.services[service].environment.APP_VERSION, "12.34.56");
      assert.equal(compose.services[service].environment.GIT_COMMIT, commit);
      assert.equal(compose.services[service].image, generated[`${service.toUpperCase()}_IMAGE`]);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
