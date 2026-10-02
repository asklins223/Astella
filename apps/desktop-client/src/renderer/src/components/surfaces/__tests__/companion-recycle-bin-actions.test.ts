/**
 * 回收区与彻底清除的**入口与措辞**（40 §11）。
 *
 * ## 为什么值得钉
 *
 * 2026-10-02 补前端通道时，最容易出的错是把这个功能做成"删除"的第三个按钮：
 * 点「删除」→ 出现「确认删除」→ 再挂一颗「彻底清除」。于是两颗按钮同一套措辞，
 * 用户分不清"一个进回收区、一个什么都不剩"。
 *
 * 而这两种后果的差别很大：错按了「删除」还能在 30 天内撤回，错按了
 * 「彻底清除」**什么都没有**。所以这里钉三件事：
 *
 *  1. 两个入口是**分开的两颗按钮**，不是一颗按钮的两种结果；
 *  2. 彻底清除那一路必须**自己说清不可逆**，不靠"删除"那颗按钮的措辞；
 *  3. 两条 API 通道都在（服务端有端点、主进程有通道、preload 暴露）。
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

// 这个文件在 src/renderer/src/components/surfaces/__tests__/ 下，往上四级是 apps/desktop-client。
const CLIENT = resolve(import.meta.dirname, "..", "..", "..", "..", "..", "..");
const read = (...parts: string[]) => readFileSync(join(CLIENT, ...parts), "utf8");

const panels = read("src", "renderer", "src", "components", "surfaces", "companion", "companion-center-panels.tsx");
const surface = read("src", "renderer", "src", "components", "surfaces", "companion", "companion-center-surface.tsx");
const ipcCompanion = read("src", "main", "desktop-ipc-companion.ts");
const preload = read("src", "preload", "index.ts");
const nsCompanion = read("src", "main", "desktop-gateway-ns-companion.ts");
const contracts = readFileSync(
  resolve(CLIENT, "..", "..", "packages", "shared", "src", "contracts", "desktop-ipc-contracts.ts"), "utf8",
);

test("彻底清除是**独立的一颗按钮**，不是删除的结果之一", () => {
  expect(panels.includes("MemoryEraseAction")).toBe(true)  // "回收区没有独立的彻底清除组件";
  // 它必须自己带 onOpen/onCancel/onConfirm，而不是复用删除那套。
  const component = panels.slice(panels.indexOf("function MemoryEraseAction"));
  const body = component.slice(0, component.indexOf("\n}"));
  expect(body.includes("onOpen") && body.includes("onConfirm") && body.includes("onCancel")).toBe(true)  // "彻底清除那一路没有自己的开/确认/取消三步";
});

test("彻底清除自己说清不可逆 —— 不靠「删除」那颗按钮的措辞", () => {
  const start = panels.indexOf("function MemoryEraseAction");
  const body = panels.slice(start, panels.indexOf("\n}", start));
  // 不可逆 + 没有回收区，两句都要在。
  expect(body).toMatch(/找不回|不可逆|撤不了/);  // 措辞里必须说不逆
  expect(body).toMatch(/回收区/);  // 必须说明没有回收区，否则用户以为还能撤
  // 而「删除」那颗按钮的措辞是另一回事，它说的是进回收区。
  const deleteStart = panels.indexOf("function MemoryDeleteAction");
  const deleteBody = panels.slice(deleteStart, panels.indexOf("\n}", deleteStart));
  expect(!/找不回|撤不了/.test(deleteBody)).toBe(true)  // "不可逆的措辞漏到了删除那一侧 —— 那会让「删除」也被当成不可逆";
});

test("两条通道都在：主进程 + preload + 共享契约", () => {
  expect(contracts.includes("companionMemoryRestoreDeleted")).toBe(true)  // "共享契约里没有恢复通道";
  expect(contracts.includes("companionMemoryErase")).toBe(true)  // "共享契约里没有彻底清除通道";
  expect(ipcCompanion.includes("DESKTOP_IPC_CHANNELS.companionMemoryRestoreDeleted")).toBe(true)  // "主进程没接恢复通道";
  expect(ipcCompanion.includes("DESKTOP_IPC_CHANNELS.companionMemoryErase")).toBe(true)  // "主进程没接彻底清除通道";
  expect(preload.includes("companionMemoryRestoreDeleted")).toBe(true)  // "preload 没暴露恢复";
  expect(preload.includes("companionMemoryErase")).toBe(true)  // "preload 没暴露彻底清除";
});

test("恢复走的是 restore-deleted，不是 restore —— 后者撤的是归档", () => {
  // 两条都叫 restore，但撤的是不同的东西。混用会让用户以为删掉的回来了。
  expect(nsCompanion.includes("/restore-deleted")).toBe(true)  // "恢复没有打 restore-deleted";
  expect(nsCompanion.includes("/erase")).toBe(true)  // "彻底清除没有打 erase";
  expect(!/memory\/\$\{safeUuid\(memoryId\)\}\/restore`/.test(nsCompanion)).toBe(true)  // "恢复被接到了普通的 restore（撤归档）上";
});

test("两处都回 null：服务端是 204，回旧快照会让面板显示成「没恢复」", () => {
  // 恢复后那一行的删除标记已变，回一份操作前的记忆体是**错的**数据，
  // 面板会短暂显示成"没恢复"。刷新列表是唯一正确口径。
  expect(contracts).toMatch(/restoreDeleted\(input: \{ meta: RequestMetaV1; memoryId: Uuid \}\): Promise<GatewayResultV1<null>>/);
  expect(contracts).toMatch(/erase\(input: \{ meta: RequestMetaV1; memoryId: Uuid \}\): Promise<GatewayResultV1<null>>/);
});

test("【自证】判据认得出「把彻底清除并成删除的第三个按钮」这个真实退化", () => {
  // 退化形状：两个入口共用一套措辞与一次确认。
  const degraded = '<button>删除</button>{active ? <button onClick={onErase}>确认删除</button> : null}';
  expect(degraded).toMatch(/确认删除/);  // 自证样本：退化形状确实共用「确认删除」
  expect(!/找不回|撤不了/.test(degraded)).toBe(true)  // "自证：退化形状里没有不可逆措辞，所以第 2 条会逮住它";
  // 正控制：真代码里有。
  const start = panels.indexOf("function MemoryEraseAction");
  expect(panels.slice(start, start + 900)).toMatch(/找不回/);  // 正控制：当前确有不可逆措辞
});
