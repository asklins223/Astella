/**
 * 验证码邮件模板的判据：码要一眼可见、样式全内联、不引外链资源
 * （邮件客户端拦外链图，任何 <img>/http 都会让版面开天窗）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildVerificationEmail } from "../verification-email.ts";

const CODE = "042517";

test("三种用途都出齐 subject/text/html，码三处都在", () => {
  for (const purpose of ["register", "login", "reset_password"] as const) {
    const mail = buildVerificationEmail(purpose, CODE);
    assert.ok(mail.subject.includes("拾星笔记"));
    assert.ok(mail.text.includes(CODE), `${purpose}: text 里要有码`);
    assert.ok(mail.html.includes(CODE), `${purpose}: html 里要有码`);
  }
});

test("用途各说各的话：注册讲建空间，登录讲免密，重置讲旧密码作废", () => {
  assert.ok(buildVerificationEmail("register", CODE).text.includes("注册拾星笔记"));
  assert.ok(buildVerificationEmail("login", CODE).text.includes("不用记密码"));
  assert.ok(buildVerificationEmail("reset_password", CODE).text.includes("立即作废"));
});

test("html 不引任何外链资源，样式全部内联", () => {
  const { html } = buildVerificationEmail("login", CODE);
  assert.ok(!/<img/i.test(html), "不能有图片标签");
  assert.ok(!/https?:\/\//i.test(html), "不能有外链（客户端多半直接吞掉）");
  assert.ok(/style="/.test(html), "样式要以内联属性随元素走");
  assert.ok(!/<style/i.test(html), "不能依赖 <style> 块（部分客户端会剥离）");
});
