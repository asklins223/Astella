import { readFileSync } from "node:fs";
import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

function loadEnv(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    env[s.slice(0, i)] = s.slice(i + 1).replace(/^["']|["']$/g, "");
  }
  return env;
}

async function body(client, bucket, key) {
  const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return res.Body.transformToString();
}

async function report(label, client, bucket) {
  const catalog = await body(client, bucket, "companion/live2d/catalog.json");
  const heads = {};
  for (const key of [
    "companion/live2d/manifest.json",
    "companion/live2d/companion-live2d-whale-v3/manifest.json",
    "companion/live2d/companion-live2d-fatfish-v4/manifest.json",
  ]) {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      heads[key] = head.ContentLength;
    } catch (error) {
      heads[key] = error.name ?? "missing";
    }
  }
  let legacyName = null;
  if (typeof heads["companion/live2d/manifest.json"] === "number") {
    const parsed = JSON.parse(await body(client, bucket, "companion/live2d/manifest.json"));
    legacyName = parsed.modelId ?? null;
  }
  console.log(JSON.stringify({ label, bucket, catalog: JSON.parse(catalog), heads, legacyName }));
}

const localEnv = loadEnv("/Users/asklins/Documents/asklins_workspace/astella/astella-service_client/.env");
const remoteEnv = loadEnv("/Users/asklins/.config/astella/rains3.env");
const local = new S3Client({
  endpoint: "http://127.0.0.1:9000",
  region: localEnv.S3_REGION || "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: localEnv.MINIO_ROOT_USER, secretAccessKey: localEnv.MINIO_ROOT_PASSWORD },
});
const remote = new S3Client({
  endpoint: remoteEnv.STORAGE_ENDPOINT,
  region: remoteEnv.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: remoteEnv.STORAGE_ACCESS_KEY_ID, secretAccessKey: remoteEnv.STORAGE_SECRET_ACCESS_KEY },
});
await report("local", local, localEnv.S3_BUCKET);
await report("remote", remote, remoteEnv.S3_BUCKET);
local.destroy();
remote.destroy();
