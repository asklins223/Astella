/**
 * 发信通道的配置判据（声明即真相）：QQ → 2925 按序降级，配置齐全才进链条。
 *
 * 只测**配置面**与"未配置就报错"——真发信要凭据与网络，属于真窗验收，
 * 不在这里假装发过。
 */
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  EmailChannelUnavailableError,
  emailChannelStatus,
  isEmailChannelConfigured,
  sendOutboundEmail,
} from "../outbound-email.ts";

const EMAIL_VARS = [
  "EMAIL_QQ_USER",
  "EMAIL_QQ_PASS",
  "EMAIL_QQ_FROM",
  "EMAIL_2925_USER",
  "EMAIL_2925_PASS",
  "EMAIL_2925_FROM",
] as const;

const saved = new Map<string, string | undefined>();
for (const name of EMAIL_VARS) saved.set(name, process.env[name]);

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function clearEnv(): void {
  for (const name of EMAIL_VARS) delete process.env[name];
}

test("两家全空：通道未配置，且逐家报出缺哪个变量", () => {
  clearEnv();
  assert.equal(isEmailChannelConfigured(), false);
  const status = emailChannelStatus();
  assert.equal(status.configured, false);
  assert.deepEqual(
    status.providers.map((p) => [p.name, p.configured]),
    [["qq", false], ["mail2925", false]],
  );
  assert.deepEqual(status.providers[0]!.missing, ["EMAIL_QQ_USER", "EMAIL_QQ_PASS"]);
  assert.deepEqual(status.providers[1]!.missing, ["EMAIL_2925_USER", "EMAIL_2925_PASS"]);
});

test("QQ 只给账号不给授权码：这一家仍不算配置齐全", () => {
  clearEnv();
  process.env.EMAIL_QQ_USER = "someone@qq.com";
  const qq = emailChannelStatus().providers.find((p) => p.name === "qq")!;
  assert.equal(qq.configured, false);
  assert.deepEqual(qq.missing, ["EMAIL_QQ_PASS"]);
  assert.equal(isEmailChannelConfigured(), false, "一家没凑齐且其余全空 = 通道未开");
});

test("QQ 齐了就开通道；2925 再齐则两家都在链条里（QQ 在前）", () => {
  clearEnv();
  process.env.EMAIL_QQ_USER = "someone@qq.com";
  process.env.EMAIL_QQ_PASS = "authcode";
  assert.equal(isEmailChannelConfigured(), true);

  process.env.EMAIL_2925_USER = "someone@2925.com";
  process.env.EMAIL_2925_PASS = "password";
  const status = emailChannelStatus();
  assert.deepEqual(
    status.providers.map((p) => p.configured),
    [true, true],
  );
});

test("一家都没配时发码直接报通道未配置，而不是连接超时", async () => {
  clearEnv();
  await assert.rejects(
    sendOutboundEmail({ to: "a@b.com", subject: "s", text: "t" }),
    EmailChannelUnavailableError,
  );
});
