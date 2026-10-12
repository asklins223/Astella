// 真窗口走查：设置 → 伴星设置 → 声音与显示 →「说话风格」（2026-10-12 instruction 链）。
// 判据：① qwen 引擎下输入框在且可见；② UI 保存真落库（psql 回读，不信 UI 回执）；
//       ③ 重开页面输入框回显库里值；④ 超限被 UI 拦（服务端合同同判据见单测
//       tts-voice-preference-contracts）；⑤ 探针值清干净不留痕。
// 用法：cd apps/desktop-client && node scripts/probe-voice-style-setting.mjs（栈与窗口要活着）
import { execSync } from "node:child_process";
import { chromium } from "playwright";

const CDP = "http://127.0.0.1:9223";
const results = [];
const note = (ok, label, detail = "") => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const psql = (sql) =>
  execSync(
    `docker exec astella-dev-postgres-1 psql -U astella -d astella -tA -c ${JSON.stringify(sql)}`,
    { encoding: "utf8" },
  ).trim();

const gotoVoiceTab = async (page) => {
  const clickByText = (pattern) =>
    page.evaluate((source) => {
      const re = new RegExp(source);
      [...document.querySelectorAll("button,[role=tab],a")]
        .find(e => e.getBoundingClientRect().width > 0 && re.test(e.textContent || ""))?.click();
    }, pattern);
  await clickByText("伴星设置");
  await page.waitForTimeout(700);
  await clickByText("声音与显示");
  await page.waitForTimeout(1200);
};

const browser = await chromium.connectOverCDP(CDP);
const page = browser.contexts()[0]?.pages()[0] ?? await browser.contexts()[0].newPage();

// 1. 进入应用（新 profile 先到登录页）。
await page.waitForTimeout(2000);
const emailBox = page.locator('input[type="email"]');
if (await emailBox.count()) {
  await emailBox.first().fill("companion-probe@astella.local");
  await page.locator('input[type="password"]').first().fill("probe-c37bpcz4");
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(5000);
}
note(await page.evaluate(() => document.body.innerText.includes("拾星书房")), "进入应用");

// 2. 导航：设置 → 伴星设置 → 声音与显示。
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button,[role=button],a")]
    .filter(e => e.getBoundingClientRect().width > 0 && /设置/.test((e.textContent || "") + (e.getAttribute("aria-label") || "")));
  btns[btns.length - 1]?.click();
});
await page.waitForTimeout(1200);
await gotoVoiceTab(page);

// 3. 输入框在不在（只在 qwen 引擎下画）。
const styleInput = page.locator("#settings-voice-style");
const hasInput = await styleInput.count();
note(hasInput > 0, "说话风格输入框渲染");
if (hasInput) {
  const box = await styleInput.boundingBox();
  note(!!box && box.width > 120, "输入框有实际尺寸", JSON.stringify(box));
  note(await page.evaluate(() => document.body.innerText.includes("说话风格")), "「说话风格」标签与说明文案在");
  await page.screenshot({ path: "outputs/voice-style-setting-2026-10-12/panel.png" }).catch(() => {});

  const userId = psql("SELECT id FROM users WHERE email = 'companion-probe@astella.local'");
  const readStored = () =>
    psql(`SELECT coalesce(explicit_preferences->>'tts_instruction', '<unset>') FROM user_learning_preferences WHERE user_id = '${userId}' AND workspace_id IS NULL`);

  // 4. UI 保存 → 落库回读（照记忆「别信 UI 回执文案」，判据在 DB）。
  const marker = `温柔自然，语速适中 probe${Date.now() % 100000}`;
  await styleInput.fill(marker);
  const saveBtn = page.locator(".settings-field").filter({ has: styleInput }).locator("button.button.primary");
  await saveBtn.click();
  await page.waitForTimeout(2500);
  const stored = readStored();
  note(stored === marker, "保存后真落库（psql 回读一致）", `db=${stored.slice(0, 60)}`);

  // 4b. 回执一致性：切走再切回这一屏，输入框该回显库里那个值（GET → 输入框）。
  await page.evaluate(() => {
    [...document.querySelectorAll("button,[role=tab],a")]
      .find(e => e.getBoundingClientRect().width > 0 && /账户与空间/.test(e.textContent || ""))?.click();
  });
  await page.waitForTimeout(600);
  await gotoVoiceTab(page);
  const echoed = await styleInput.inputValue().catch(() => "");
  note(echoed === marker, "切走再切回，输入框回显库里值", `ui=${echoed.slice(0, 60)}`);

  // 5. 超限：UI 该拦（保存键禁用 + alert）。服务端合同同判据见单测。
  await styleInput.fill("温柔".repeat(60));
  await page.waitForTimeout(400);
  const saveDisabled = await saveBtn.isDisabled();
  const alertText = await page.evaluate(() => document.querySelector('.settings-field [role="alert"]')?.textContent ?? "");
  note(saveDisabled && /超出/.test(alertText), "超限时保存键禁用并有 alert", alertText.slice(0, 90));
  await page.screenshot({ path: "outputs/voice-style-setting-2026-10-12/over-limit.png" }).catch(() => {});

  // 6. 清回原样（别把探针值留在他账号里）。
  await styleInput.fill("");
  await page.waitForTimeout(300);
  await saveBtn.click();
  await page.waitForTimeout(2000);
  const cleared = readStored();
  note(cleared === "<unset>", "探针值已清除（库里回 <unset>）", `db=${cleared.slice(0, 40)}`);
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
await browser.close();
process.exit(failed.length ? 1 : 0);
