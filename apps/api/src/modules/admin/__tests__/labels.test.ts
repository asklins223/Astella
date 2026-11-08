import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITY_KINDS, PROVIDER_METADATA } from "@astella/shared";
import { CAPABILITY_KIND_LABELS, PROVIDER_TYPE_LABELS, providerTypeLabel } from "../labels.ts";

/**
 * 面板是「配置的镜子」：服务端清单里有的能力/协议，页面上都得有中文名。
 *
 * 这两条断言守的是同一段历史：config-service 原先把已知清单抄了一份，
 * 新增 provider 与 `embedding_fallback` 能力时没跟着改，面板就把**完全正确**
 * 的配置报成「未知能力 / 未知平台类型」——假告警比没有告警更贵。现在清单由
 * `@astella/shared` 派生，这里再加一道闸：派生之后若是有人漏了中文名，
 * 至少测试会先红，而不是让运维先看见一串 `agent_turn`。
 */

test("能力清单：每个 Capability 都有中文名（漏了会把代号露在页面上）", () => {
  for (const kind of CAPABILITY_KINDS) {
    assert.ok(CAPABILITY_KIND_LABELS[kind], `缺少能力 "${kind}" 的中文名`);
  }
});

test("provider 类型：人话名由 PROVIDER_METADATA 派生，与注册表逐条一致", () => {
  for (const provider of PROVIDER_METADATA) {
    assert.equal(PROVIDER_TYPE_LABELS[provider.id], provider.label, `provider "${provider.id}" 的文案不一致`);
    assert.equal(providerTypeLabel(provider.id), provider.label);
  }
});

test("未知类型原样返回：真的写错时要看得见原始值，而不是被折叠成一句话", () => {
  assert.equal(providerTypeLabel("not_a_real_protocol"), "not_a_real_protocol");
  assert.equal(providerTypeLabel(null), "—");
});
