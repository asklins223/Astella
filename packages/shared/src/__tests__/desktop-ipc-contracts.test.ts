import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_IPC_CONTRACT_VERSION,
  apiConnectionStateSchema,
  capabilityProjectionSchema,
  clipboardReadLinksResultSchema,
  commandReceiptSchema,
  deploymentConfigSchema,
  desktopContractSnapshotSchema,
  desktopNamespaceM2Values,
  desktopRouteKindM2Values,
  desktopTrustChallengeRequestSchema,
  extractCandidateLinks,
  gatewayEventSchema,
  gatewayResultSchema,
  localApiTrustSchema,
  learningRoomManifestSchema,
  navigationEntrySchema,
  sessionContextSchema,
  staticAssetPathSchema,
  workspaceContextSchema,
} from "../contracts/desktop/desktop-ipc-contracts.ts";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";

test("room scene families can share a plate while every asset path stays confined", () => {
  const plate = "posters/home-v2/lighthouse/lighthouse-day-poster-v1.png";
  const manifest = {
    version: 1, schemaVersion: 1, id: "room", canonicalMode: "2d",
    basePath: "/assets/learning-room/v1",
    assets: { "homeV2Posters.day": plate, "seatPosters.day": plate },
  };
  assert.deepEqual(learningRoomManifestSchema.parse(manifest).assets, manifest.assets);
  for (const invalid of ["../outside.png", "/outside.png", "https://example.com/outside.png"]) {
    assert.throws(() => learningRoomManifestSchema.parse({ ...manifest, assets: { ...manifest.assets, invalid } }));
  }
});

test("M1 contract snapshot rejects duplicate and ungated routes", () => {
  const valid = {
    version: 1 as const,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: "domain-v2",
    deploymentConfigRevision: "deployment-v1",
    namespaces: ["runtime", "navigation", "auth", "workspace", "capabilities", "window", "subscriptions"] as const,
    enabledRoutes: ["auth.login", "auth.register"] as const,
  };
  assert.deepEqual(desktopContractSnapshotSchema.parse(valid).enabledRoutes, valid.enabledRoutes);
  assert.throws(() => desktopContractSnapshotSchema.parse({ ...valid, enabledRoutes: ["auth.login", "auth.login"] }));
  assert.throws(() => desktopContractSnapshotSchema.parse({ ...valid, enabledRoutes: ["room.home"] }));
});

test("authenticated session accepts the strict workspace context shape", () => {
  const workspace = {
    version: 1 as const,
    workspaceId: WORKSPACE_ID,
    name: "Owner workspace",
    role: "owner" as const,
    workspaceType: "personal" as const,
    isPersonal: true,
    workspaceEpoch: 7,
  };
  assert.deepEqual(workspaceContextSchema.parse(workspace), workspace);
  const session = sessionContextSchema.parse({
    version: 1,
    status: "authenticated",
    user: { userId: USER_ID, email: "owner@example.com" },
    workspace,
    membership: { role: "owner" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  });
  assert.equal(session.status, "authenticated");
});

test("authenticated member accepts a collaborative projection of an owner personal workspace", () => {
  const workspace = {
    version: 1 as const,
    workspaceId: WORKSPACE_ID,
    name: "Shared workspace",
    role: "member" as const,
    workspaceType: "collaborative" as const,
    isPersonal: false,
    workspaceEpoch: 7,
  };
  const session = sessionContextSchema.parse({
    version: 1,
    status: "authenticated",
    user: { userId: USER_ID, email: "member@example.com" },
    workspace,
    membership: { role: "member" },
    capabilities: null,
    workspaceEpoch: 7,
    credentialPersistence: "memory",
  });
  assert.equal(session.workspace?.workspaceType, "collaborative");
  assert.equal(session.workspace?.isPersonal, false);
});

test("M2 roster is explicitly gated", () => {
  const contract = desktopContractSnapshotSchema.parse({
    version: 1 as const,
    contractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    domainSchemaRevision: "domain-v2",
    deploymentConfigRevision: "deployment-v1",
    namespaces: [...desktopNamespaceM2Values],
    enabledRoutes: [...desktopRouteKindM2Values],
  });
  assert.equal(contract.enabledRoutes.includes("room.home"), true);
});



test("navigation scope is fail-closed", () => {
  const gate = {
    version: 1 as const,
    scope: "gate" as const,
    historyKey: "h1",
    route: { kind: "auth.login" as const },
    entryKind: "startup" as const,
    correlationId: "corr-1",
  };
  assert.equal(navigationEntrySchema.parse(gate).scope, "gate");
  assert.throws(() => navigationEntrySchema.parse({ ...gate, workspaceId: WORKSPACE_ID }));
  assert.throws(() => navigationEntrySchema.parse({ ...gate, route: { kind: "room.home" } }));
});

test("deployment config keeps local trust and remote HTTPS mutually exclusive", () => {
  assert.equal(
    deploymentConfigSchema.parse({
      version: 1,
      mode: "local_loopback",
      apiOrigin: "http://127.0.0.1:4000",
      localServiceTrust: "hmac_pairing_v1",
      expectedServiceId: "astella-api",
      expectedDomainSchemaRevision: "domain-v2",
      pairingKeyId: "key-1",
      configRevision: "deployment-v1",
    }).mode,
    "local_loopback",
  );
  assert.throws(() => deploymentConfigSchema.parse({
    version: 1,
    mode: "local_loopback",
    apiOrigin: "http://localhost:4000",
    localServiceTrust: "hmac_pairing_v1",
    expectedServiceId: "astella-api",
    expectedDomainSchemaRevision: "domain-v2",
    pairingKeyId: "key-1",
    configRevision: "deployment-v1",
  }));
  assert.throws(() => deploymentConfigSchema.parse({
    version: 1,
    mode: "remote_https",
    apiOrigin: "https://example.com/path",
    expectedDomainSchemaRevision: "domain-v2",
    configRevision: "deployment-v1",
    localServiceTrust: "hmac_pairing_v1",
  }));
});

test("api_unavailable and api_untrusted remain distinct renderer states", () => {
  assert.equal(apiConnectionStateSchema.parse({ version: 1, kind: "api_unavailable" }).kind, "api_unavailable");
  assert.equal(apiConnectionStateSchema.parse({ version: 1, kind: "api_untrusted", reason: "wrong_service" }).kind, "api_untrusted");
  assert.throws(() => apiConnectionStateSchema.parse({ version: 1, kind: "anonymous" }));
});

test("gateway and command envelopes reject raw unknown fields and false commits", () => {
  const resultSchema = gatewayResultSchema(capabilityProjectionSchema);
  assert.equal(resultSchema.parse({
    version: 1,
    ok: false,
    error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action" },
    requestId: "request-1",
    correlationId: "correlation-1",
    schemaRevision: "desktop-ipc-m1",
  }).ok, false);
  assert.throws(() => resultSchema.parse({
    version: 1,
    ok: false,
    error: { code: "api_unavailable", safeMessageKey: "error.api_unavailable", retry: "user_action", raw: "secret" },
    requestId: "request-1",
    correlationId: "correlation-1",
    schemaRevision: "desktop-ipc-m1",
  }));

  const receiptSchema = commandReceiptSchema(capabilityProjectionSchema);
  assert.throws(() => receiptSchema.parse({
    version: 1,
    commandId: "command-1",
    state: "unknown",
    result: {},
    resyncHint: { kind: "entity", ref: "workspace" },
  }));
});

test("asset and trust challenge scalars fail closed", () => {
  assert.equal(staticAssetPathSchema.parse("posters/room-day.webp"), "posters/room-day.webp");
  assert.throws(() => staticAssetPathSchema.parse("../room-day.webp"));
  assert.throws(() => staticAssetPathSchema.parse("https://example.com/room.webp"));
  assert.throws(() => desktopTrustChallengeRequestSchema.parse({
    version: 1,
    nonce: "short",
    ipcContractVersion: DESKTOP_IPC_CONTRACT_VERSION,
    pairingKeyId: "key-1",
  }));
  assert.equal(localApiTrustSchema.parse({
    version: 1,
    state: "untrusted",
    origin: "http://127.0.0.1:4000",
    serviceId: "astella-api",
    transportEpoch: 1,
  }).state, "untrusted");
  assert.equal(gatewayEventSchema.parse({
    version: 1,
    subscriptionId: "subscription-1",
    workspaceEpoch: 0,
    cursor: "cursor-1",
    eventRevision: 0,
    kind: "connection_changed",
    schemaRevision: "desktop-ipc-m1",
    data: { kind: "connection_changed", state: { version: 1, kind: "api_unavailable" } },
  }).workspaceEpoch, 0);
  assert.throws(() => gatewayEventSchema.parse({
    version: 1,
    subscriptionId: "subscription-1",
    workspaceEpoch: 0,
    cursor: "cursor-1",
    eventRevision: 0,
    kind: "snapshot_invalidated",
    schemaRevision: "desktop-ipc-m1",
    data: { kind: "snapshot_invalidated", scope: "workspace" },
  }));
  assert.notEqual(WORKSPACE_ID, USER_ID);
});

test("extractCandidateLinks 只收 http(s) 链接并归一化去重", () => {
  assert.deepEqual(
    extractCandidateLinks("看看这个 https://example.com/a?p=1，正文。"),
    ["https://example.com/a?p=1"],
  );
  // 尾巴标点与右括号剥掉，重复只留一个，数量封顶。
  assert.deepEqual(
    extractCandidateLinks("(https://a.test/1，https://a.test/1) https://b.test/2! https://c.test/3 https://d.test/4"),
    ["https://a.test/1", "https://b.test/2", "https://c.test/3"],
  );
  // 非目标协议与带账密的一律不要。
  assert.deepEqual(extractCandidateLinks("ftp://a.test/x file:///etc/passwd example.com"), []);
  assert.deepEqual(extractCandidateLinks("https://user:pass@a.test/x"), []);
  assert.deepEqual(extractCandidateLinks("只是普通密码 Abc123!@#"), []);
  assert.deepEqual(extractCandidateLinks(""), []);
});

test("clipboardReadLinksResultSchema 拒绝超长与超量", () => {
  assert.equal(clipboardReadLinksResultSchema.safeParse({ urls: [] }).success, true);
  assert.equal(
    clipboardReadLinksResultSchema.safeParse({ urls: ["https://a.test/1", "https://b.test/2", "https://c.test/3", "https://d.test/4"] }).success,
    false,
  );
});
