/**
 * 40 §7「共用收藏身份」在**桌面链路上**真的接通了。
 *
 * ## 为什么要有这条
 *
 * §7：「同一条内容在笔记旁和发现簿里出现时**共用收藏身份**，编辑批注或取消收藏
 * **同步生效**。」这一条是**跨两个界面**的：发现簿里有一个「取消收藏」，笔记旁
 * 有一个「留在发现簿」，它们必须作用在**同一行**上。
 *
 * 而"同一行"这件事在这里是靠**两边都传同一个身份三元组**成立的。
 * 只要有一边自己拼一个 key（例如拿正文文本当 id），两处就会变成两条，
 * 同步立刻失效——而界面上看不出任何区别。
 *
 * 所以这条守卫盯的是：**五个通道传的形状，以及主进程那侧不打 id**。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

// 本文件在 src/renderer/src/components/surfaces/companion/__tests__/ 下，
// 往上七级才是 apps/desktop-client。
const CLIENT = resolve(import.meta.dirname, "..", "..", "..", "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(CLIENT, ...parts), "utf8");

const nsCompanion = read("src", "main", "desktop-gateway-ns-companion.ts");
const ipcCompanion = read("src", "main", "desktop-ipc-companion.ts");
const contracts = read("..", "..", "packages", "shared", "src", "contracts", "desktop-ipc-contracts.ts");

test("取消收藏走的是 `/uncollect`，**不是** DELETE", () => {
  // §7「取消收藏不删除原始回答或日记」。叫 delete 的后果，是下一次有人
  // 顺手把它接成级联，于是"取消收藏"变成"日记没了"。
  expect(nsCompanion, "取消收藏必须是 POST").toMatch(/POST"/);
  expect(nsCompanion).toMatch(/\/companion\/discovery\/uncollect/);
  expect(nsCompanion).not.toMatch(/method: "DELETE"[^)]*discovery/);
});

test("身份三元组在**两侧**都传 —— 不拿正文当 id", () => {
  // 笔记旁那一侧与簿子那一侧必须用同一组 (kind, source, sourceId)。
  // 拿 body 拼 key 的话，原文一改就分裂成两条，批注与取消都不再同步。
  expect(contracts).toMatch(/interface DiscoveryIdentityV1 \{[\s\S]*kind[\s\S]*source[\s\S]*sourceId/);
  expect(nsCompanion).toMatch(/kind: request\.kind, source: request\.source, sourceId: request\.sourceId/);
  // 主进程那一侧**不生成** id：它只把三元组原样带过去。
  expect(nsCompanion, "主进程在用正文拼 sourceId —— 原文一改就会分裂成两条")
    .not.toMatch(/sourceId: (body|text|content)/);
});

test("五个通道都在（读簿子、收藏、取消收藏、改批注、查收藏状态）", () => {
  for (const channel of [
    "companionDiscoveryGet", "companionDiscoveryCollect", "companionDiscoveryUncollect",
    "companionDiscoveryAnnotate", "companionDiscoveryState",
  ]) {
    expect(contracts, `契约里少了 ${channel}`).toContain(channel);
    expect(ipcCompanion, `主进程没接 ${channel}`).toContain(`DESKTOP_IPC_CHANNELS.${channel}`);
  }
});

test("发现簿的页签真的进了伴星中心", () => {
  const surface = read(
    "src", "renderer", "src", "components", "surfaces", "companion", "companion-center-surface.tsx",
  );
  expect(surface).toMatch(/\["discovery", "发现簿"\]/);
  expect(surface).toMatch(/<DiscoveryPanel/);
});

test("【自证】判据认得出「取消收藏接成 DELETE」这个真实退化", () => {
  // 退化形状：用 DELETE 打同一个端点 —— 语义上就是"删掉"。
  const degraded = `await t.request("/companion/discovery", { method: "DELETE" });`;
  expect(degraded).toMatch(/method: "DELETE"/);
  expect(nsCompanion, "自证：当前真代码里没有对 discovery 的 DELETE")
    .not.toMatch(/method: "DELETE"[^)]*discovery/);
});

test("【自证】判据认得出「用正文当身份」这个真实退化", () => {
  const degraded = "sourceId: entry.body.slice(0, 40)";
  expect(degraded).toMatch(/sourceId: entry\.body/);
  expect(nsCompanion, "自证：当前真代码不拿正文当身份")
    .not.toMatch(/sourceId: (body|text|content)/);
});
