/**
 * 制卡链总控自己的三档读数（39d W7-7 刀一）。
 *
 * 入口台账（`packages/shared/src/card-generation-chain-entry-inventory.test.ts`）判的是
 * "每一发都问过总控、新链排在前"；这一份判的是总控本身那三格：
 * **未设＝新链**（翻默认档这件事）、**显式 `v2`＝完整回到改前**（off 档）、
 * **坏值＝落在新默认档**（配置笔误不该把一条要退役的链复活）。
 * 三格缺一格，"切换"就只有一个方向可读。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  CARD_GENERATION_CHAIN_ENV,
  cardGenerationSimplifiedChainV3,
} from "../modules/card-generation-v2/helpers.ts";

const previous = process.env[CARD_GENERATION_CHAIN_ENV];
afterEach(() => {
  if (previous === undefined) delete process.env[CARD_GENERATION_CHAIN_ENV];
  else process.env[CARD_GENERATION_CHAIN_ENV] = previous;
});

describe("制卡链总控：默认档、off 档与坏值", () => {
  it("未设开关走简化链（这就是 W7-7 刀一翻的那一格）", () => {
    delete process.env[CARD_GENERATION_CHAIN_ENV];
    assert.equal(cardGenerationSimplifiedChainV3(), true);
  });

  it("显式写 v2 完整回到改前那一档", () => {
    process.env[CARD_GENERATION_CHAIN_ENV] = "v2";
    assert.equal(cardGenerationSimplifiedChainV3(), false);
    process.env[CARD_GENERATION_CHAIN_ENV] = " V2 ";
    assert.equal(cardGenerationSimplifiedChainV3(), false, "大小写与首尾空格不该改变档位");
  });

  it("坏值落在新默认档，不把旧链复活", () => {
    for (const typo of ["simplified-v3", "simplified", "true", "", "1"]) {
      process.env[CARD_GENERATION_CHAIN_ENV] = typo;
      assert.equal(cardGenerationSimplifiedChainV3(), true,
        `写了「${typo}」却回旧链：一条要退役的链会因为配置笔误重新接住生产流量`);
    }
  });
});
