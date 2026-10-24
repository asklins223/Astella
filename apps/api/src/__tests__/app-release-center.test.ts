import assert from "node:assert/strict";
import { test } from "node:test";
import { validateClientAssets, ManifestValidationError } from "../modules/app-release/manifest.ts";
import { clientAssetsRegistrationSchema, appReleaseRegistrationSchema } from "../modules/app-release/schema.ts";
import { compareVersions } from "../modules/app-release/version.ts";

function asset(platform: "ios" | "android", path: string) {
  const file = { path, sha256: "a".repeat(64), byteLength: 10 };
  return {
    platform,
    channel: "stable",
    version: "ios-2026.10.24-1",
    baseVersion: null,
    releasedAt: "2026-10-24T12:00:00+08:00",
    manifest: { version: "ios-2026.10.24-1", files: [{ ...file, url: `https://assets.example.com/${path}` }] },
    files: [file],
    activate: true,
  };
}

test("version comparison orders numeric release lines", () => {
  assert.equal(compareVersions("2.0.0", "1.9.9"), 1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("2.0.1", "2.0.0"), 1);
});

test("iOS asset manifest accepts notes-web and launch-motion paths", () => {
  const input = clientAssetsRegistrationSchema.parse(asset("ios", "notes-web/reader.js"));
  assert.doesNotThrow(() => validateClientAssets(input));
  const motion = clientAssetsRegistrationSchema.parse(asset("ios", "launch-motion/index.html"));
  assert.doesNotThrow(() => validateClientAssets(motion));
});

test("asset manifest rejects unsafe, out-of-scope and duplicate paths", () => {
  const outOfScope = clientAssetsRegistrationSchema.parse(asset("android", "notes-web/reader.js"));
  assert.throws(() => validateClientAssets(outOfScope), ManifestValidationError);
  const unsafe = clientAssetsRegistrationSchema.parse(asset("ios", "notes-web/../secret.js"));
  assert.throws(() => validateClientAssets(unsafe), ManifestValidationError);
});

test("asset manifest requires files list to match manifest", () => {
  const input = clientAssetsRegistrationSchema.parse(asset("ios", "launch-motion/index.html"));
  input.files[0]!.sha256 = "b".repeat(64);
  assert.throws(() => validateClientAssets(input), ManifestValidationError);
});

test("app release registration keeps full package metadata and rejects unknown platform", () => {
  const parsed = appReleaseRegistrationSchema.parse({
    platform: "ios",
    version: "2.0.0",
    build: 1,
    tag: "i-v2.0.0",
    releasedAt: "2026-10-24T12:00:00+08:00",
    signed: false,
    packages: [{ kind: "full", name: "Astella.ipa", url: "https://github.com/x/y/releases/download/i-v2.0.0/Astella.ipa", sha256: "c".repeat(64), byteLength: 10 }],
  });
  assert.equal(parsed.platform, "ios");
  assert.equal(parsed.packages[0]?.kind, "full");
  assert.throws(() => appReleaseRegistrationSchema.parse({ ...parsed, platform: "linux" }));
});
