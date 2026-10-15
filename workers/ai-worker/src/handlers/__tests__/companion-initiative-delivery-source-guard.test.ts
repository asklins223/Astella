import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { COMPANION_INITIATIVE_DELIVERY_TTL_HOURS } from "@astella/shared/companion-initiative-contracts";

/**
 * 她主动开口的那句话，两处发起点都必须用**声明好的认领窗口**。
 *
 * 写死的 `ttlHours: 0.025`（=90 秒）就是"她说了没人接"的落点：投递只活 90 秒，
 * 而那 90 秒里他大概率不在小屋界面。实测 16 条主动投递 11 条停在 `queued` 直到过期。
 * 窗口本身为什么是现在这个数，见 shared 的 `COMPANION_INITIATIVE_DELIVERY_TTL_HOURS` 注释。
 *
 * 这里钉的是"别再出现一个字面量"——两处发起点（普通收尾与她说工具那一支）漂移一次，
 * 症状就是其中一条路重新把话扔掉，而那 kinds 只有翻库才看得出来。
 */
const HANDLERS = ["companion-dialogue.ts", "companion-participation-tools.ts"];

for (const file of HANDLERS) {
  test(`${file} 的主动投递用声明窗口，不再自己写秒数`, () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
    assert.match(source, /ttlHours:\s*COMPANION_INITIATIVE_DELIVERY_TTL_HOURS/, file);
    assert.doesNotMatch(source, /ttlHours:\s*[\d.]/, `${file} 里不该再有写死的投递时长`);
  });
}

test("认领窗口比一次起身倒水长", () => {
  assert.ok(COMPANION_INITIATIVE_DELIVERY_TTL_HOURS * 60 >= 90);
});
