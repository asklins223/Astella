/**
 * 出站邮件通道（邮箱验证码的发送底座）。
 *
 * 两家按序降级：QQ 邮箱 SMTP → 2925 无限邮 SMTP。
 * 顺序即优先级：先试主通道，任何一步失败（认证、连接、超额、超时）换下一家，
 * 全部失败才向调用方报错——错误里带上每一家的失败原因，方便定位是哪家没配好。
 *
 * 「配置齐全」是通道存在的唯一判据（声明即真相）：一家的必需凭据没凑齐，
 * 这一家就不进链条；两家都没凑齐时整条通道视为未配置，验证码功能随之整体
 * 关闭（注册不要求验证码、发码接口返回 503）。不做"看起来能发其实发不出"。
 *
 * 环境变量在**每次调用时**读取，不在模块加载时快照：测试可以先 import 再设 env。
 */

import nodemailer from "nodemailer";

export type EmailProviderName = "qq" | "mail2925";

export interface OutboundEmailMessage {
  to: string;
  subject: string;
  text: string;
  /** 富文本正文（可选）；两家都是 nodemailer，html 原样透传。 */
  html?: string;
}

/** 两家都没配齐：通道未配置（不是故障，是能力没开）。 */
export class EmailChannelUnavailableError extends Error {
  constructor() {
    super("email channel is not configured");
    this.name = "EmailChannelUnavailableError";
  }
}

/** 配了但全军覆没：带每一家的失败原因（不含验证码正文）。 */
export class EmailSendFailedError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`all email providers failed: ${failures.join("; ")}`);
    this.name = "EmailSendFailedError";
  }
}

export interface EmailProviderStatus {
  name: EmailProviderName;
  configured: boolean;
  /** 未配置时缺什么（已配置则为空）。 */
  missing: string[];
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const SENDER_NAME = "拾星笔记";
const SMTP_TIMEOUT_MS = 10_000;

interface EmailProvider {
  send(message: OutboundEmailMessage): Promise<void>;
}

interface ProviderEntry {
  name: EmailProviderName;
  provider: EmailProvider | null;
  missing: string[];
}

function smtpEntry(
  name: EmailProviderName,
  userEnv: string,
  passEnv: string,
  fromEnv: string,
  host: string,
): ProviderEntry {
  const user = env(userEnv);
  const pass = env(passEnv);
  const missing = [
    ...(user ? [] : [userEnv]),
    ...(pass ? [] : [passEnv]),
  ];
  if (!user || !pass) return { name, provider: null, missing };
  // 发件地址默认就是账号本身：QQ/2925 这类个人邮箱只认自己的地址做 From，
  // 需要别名时用 fromEnv 覆盖（前提别名已挂在该账号下）。
  const from = env(fromEnv) ?? user;
  return {
    name,
    missing: [],
    provider: {
      async send(message) {
        const transport = nodemailer.createTransport({
          host,
          port: 465,
          secure: true,
          auth: { user, pass },
          connectionTimeout: SMTP_TIMEOUT_MS,
          greetingTimeout: SMTP_TIMEOUT_MS,
          socketTimeout: SMTP_TIMEOUT_MS,
        });
        try {
          await transport.sendMail({
            from: `"${SENDER_NAME}" <${from}>`,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html ? { html: message.html } : {}),
          });
        } finally {
          transport.close();
        }
      },
    },
  };
}

/** 两家的唯一清单：顺序即降级顺序，status 与发送链都从这里取。 */
function providerCatalog(): ProviderEntry[] {
  return [
    smtpEntry("qq", "EMAIL_QQ_USER", "EMAIL_QQ_PASS", "EMAIL_QQ_FROM", "smtp.qq.com"),
    smtpEntry(
      "mail2925",
      "EMAIL_2925_USER",
      "EMAIL_2925_PASS",
      "EMAIL_2925_FROM",
      // 实测（2026-10-11）：smtp.2925.com:465 可连通，587 不通；
      // 教程里出现过的 smtp.2925mail.com 已无 DNS 记录。
      "smtp.2925.com",
    ),
  ];
}

/** 每家通道的配置状态（缺哪家的哪个变量），供诊断与公开能力位使用。 */
export function emailChannelStatus(): { configured: boolean; providers: EmailProviderStatus[] } {
  const providers = providerCatalog().map(({ name, provider, missing }) => ({
    name,
    configured: provider !== null,
    missing,
  }));
  return { configured: providers.some((entry) => entry.configured), providers };
}

/** 通道是否至少有一家配置齐全——验证码功能的总开关。 */
export function isEmailChannelConfigured(): boolean {
  return emailChannelStatus().configured;
}

/**
 * 发一封信，按序降级。返回实际投递成功的通道名。
 * 未配置抛 EmailChannelUnavailableError；全部失败抛 EmailSendFailedError。
 */
export async function sendOutboundEmail(
  message: OutboundEmailMessage,
): Promise<EmailProviderName> {
  const catalog = providerCatalog().filter((entry) => entry.provider !== null);
  if (catalog.length === 0) throw new EmailChannelUnavailableError();
  const failures: string[] = [];
  for (const entry of catalog) {
    try {
      await entry.provider!.send(message);
      return entry.name;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${entry.name}: ${detail}`);
    }
  }
  throw new EmailSendFailedError(failures);
}
