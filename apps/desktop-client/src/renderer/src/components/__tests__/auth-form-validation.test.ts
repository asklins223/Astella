import { describe, expect, it } from "vitest";
import {
  MIN_PASSWORD_LENGTH,
  validateAuthForm,
  validateEmailCode,
  validateEmailFormat,
  validateResetForm,
} from "../auth-form-validation.ts";

const base = { mode: "register" as const, email: "student@example.com", password: "long-enough", confirmPassword: "long-enough" };

describe("validateAuthForm", () => {
  it("accepts a well-formed registration", () => {
    expect(validateAuthForm(base)).toBeNull();
  });

  it("accepts a short password when signing in, because the API does", () => {
    expect(validateAuthForm({ ...base, mode: "login", password: "abcd", confirmPassword: "" })).toBeNull();
  });

  it("requires an email", () => {
    expect(validateAuthForm({ ...base, email: "   " })).toBe("请输入邮箱。");
  });

  it("rejects an address the API would reject", () => {
    expect(validateAuthForm({ ...base, email: "not-an-email" })).toBe("邮箱格式看起来不对，请检查后重试。");
  });

  it("names the real minimum instead of a generic failure", () => {
    expect(validateAuthForm({ ...base, password: "1234567", confirmPassword: "1234567" }))
      .toBe(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`);
  });

  it("accepts exactly the minimum length", () => {
    expect(validateAuthForm({ ...base, password: "12345678", confirmPassword: "12345678" })).toBeNull();
  });

  it("catches a mistyped confirmation before the account is created", () => {
    expect(validateAuthForm({ ...base, confirmPassword: "long-enogh" })).toBe("两次输入的密码不一致，请重新确认。");
  });

  it("checks the password before the confirmation, so the fix order is obvious", () => {
    expect(validateAuthForm({ ...base, password: "short", confirmPassword: "different" }))
      .toBe(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`);
  });
});

describe("validateEmailFormat", () => {
  it("accepts a well-formed address", () => {
    expect(validateEmailFormat(" student@example.com ")).toBeNull();
  });

  it("names the missing email instead of a generic failure", () => {
    expect(validateEmailFormat("  ")).toBe("请输入邮箱。");
  });

  it("rejects an address the API would reject", () => {
    expect(validateEmailFormat("not-an-email")).toBe("邮箱格式看起来不对，请检查后重试。");
  });
});

describe("validateEmailCode", () => {
  it("accepts exactly six digits", () => {
    expect(validateEmailCode("042517")).toBeNull();
    expect(validateEmailCode(" 123456 ")).toBeNull();
  });

  it("rejects a blank, short, or non-numeric code locally", () => {
    expect(validateEmailCode("")).toBe("请输入 6 位邮箱验证码。");
    expect(validateEmailCode("12345")).toBe("请输入 6 位邮箱验证码。");
    expect(validateEmailCode("12345a")).toBe("请输入 6 位邮箱验证码。");
  });
});

describe("validateResetForm", () => {
  const valid = {
    email: "student@example.com",
    code: "042517",
    password: "long-enough",
    confirmPassword: "long-enough",
  };

  it("accepts a complete reset form", () => {
    expect(validateResetForm(valid)).toBeNull();
  });

  it("checks in the order the fields appear: email, code, then passwords", () => {
    expect(validateResetForm({ ...valid, email: "bad" })).toBe("邮箱格式看起来不对，请检查后重试。");
    expect(validateResetForm({ ...valid, email: "bad", code: "12" }))
      .toBe("邮箱格式看起来不对，请检查后重试。");
    expect(validateResetForm({ ...valid, code: "12" })).toBe("请输入 6 位邮箱验证码。");
    expect(validateResetForm({ ...valid, code: "12", password: "short" }))
      .toBe("请输入 6 位邮箱验证码。");
    expect(validateResetForm({ ...valid, password: "short" }))
      .toBe(`密码至少需要 ${MIN_PASSWORD_LENGTH} 位。`);
    expect(validateResetForm({ ...valid, confirmPassword: "different" }))
      .toBe("两次输入的密码不一致，请重新确认。");
  });
});
