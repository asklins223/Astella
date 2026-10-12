/**
 * 验证码邮件的正文设计（纯排版，不用外链图片）。
 *
 * 邮件客户端普遍拦外链图、剥离 <style>，所以样式全部内联、版面用 table——
 * 这是邮件 HTML 的唯一稳妥姿势。视觉与应用同源：暖纸底 + 奶白卡片 + 深墨字
 * （gate 主按钮同款 #3e2d22）+ 虚线码框，星标 ✦ 只做点缀不堆装饰。
 *
 * 纯函数：入参用途与码，出参 { subject, text, html }，可单测。
 * 住在 identity 模块内而不是 lib/：它是这一个域的文案，不是基础设施。
 */

/** 验证码用途；文案按用途分，所以这份联合类型由本文件持有。 */
export type EmailCodePurpose = "register" | "login" | "reset_password";

const PURPOSE_COPY: Record<EmailCodePurpose, { action: string; context: string }> = {
  register: {
    action: "注册拾星笔记",
    context: "在这台设备上建一个属于你的学习空间。",
  },
  login: {
    action: "登录拾星笔记",
    context: "用验证码进屋，不用记密码。",
  },
  reset_password: {
    action: "重置拾星笔记密码",
    context: "设一个新密码，旧的会立即作废。",
  },
};

export interface VerificationEmail {
  subject: string;
  text: string;
  html: string;
}

export function buildVerificationEmail(
  purpose: EmailCodePurpose,
  code: string,
): VerificationEmail {
  const copy = PURPOSE_COPY[purpose];
  const subject = `【拾星笔记】邮箱验证码`;

  const text = [
    `你正在${copy.action}。`,
    "",
    `验证码：${code}`,
    "",
    `${copy.context}验证码 5 分钟内有效。`,
    "如果不是你本人操作，忽略这封邮件即可。",
    "",
    "—— 拾星笔记",
  ].join("\n");

  const html = `<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:0;background-color:#f4efe6;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f4efe6;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
    <tr>
      <td align="center" style="padding:36px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:420px;background-color:#fffdf8;border:1px solid #e7ddcc;border-radius:14px;">
          <tr>
            <td style="padding:34px 32px 28px;">
              <!-- 抬头 -->
              <p style="margin:0 0 26px;font-size:13px;font-weight:700;letter-spacing:0.18em;color:#a08a63;">
                ✦&nbsp;&nbsp;拾星笔记
              </p>
              <!-- 来意 -->
              <p style="margin:0 0 6px;font-size:15px;color:#3e2d22;font-weight:600;">
                你正在${copy.action}
              </p>
              <p style="margin:0 0 24px;font-size:13px;line-height:1.7;color:#8b7d67;">
                ${copy.context}
              </p>
              <!-- 验证码 -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:#f7f0e2;border:1px dashed #d9c7a4;border-radius:10px;">
                <tr>
                  <td align="center" style="padding:20px 12px;">
                    <span style="display:inline-block;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:#3e2d22;padding-left:10px;">${code}</span>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0;font-size:12px;line-height:1.7;color:#8b7d67;">
                5 分钟内有效，只能用一次。不是你本人操作的话，忽略这封邮件就好。
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 30px;">
              <p style="margin:0;padding-top:18px;border-top:1px solid #eee4d2;font-size:11px;line-height:1.8;color:#b3a58c;">
                这是一封验证码邮件，不会有推销内容，也不会要求你点击链接。<br/>
                © 拾星笔记 · 在纸上，把星星一颗颗收起来
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
