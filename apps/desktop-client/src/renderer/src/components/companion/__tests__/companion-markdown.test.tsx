// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainCompanionBubbleText, renderCompanionMarkdown } from "../companion-markdown.tsx";

/** 打开通道换成记账替身：这个文件只验"点了有没有把地址交出去、交的是哪一条"。 */
const { opened } = vi.hoisted(() => ({ opened: [] as string[] }));
vi.mock("../../../app/external-link", () => ({
  openExternalLink: (url: string) => { opened.push(url); return Promise.resolve(true); },
}));

function show(text: string) {
  return render(<div data-testid="root">{renderCompanionMarkdown(text)}</div>);
}

afterEach(() => {
  opened.length = 0;
  cleanup();
});

describe("renderCompanionMarkdown（§4.8：可见正文保留结构，由渲染层排版）", () => {
  it("行内加粗 / 斜体 / 代码变成元素，标记符号不留在文字里", () => {
    show("先**关燃气**，公式是 `I=U/R`，*慢慢来*。");
    expect(screen.getByText("关燃气").tagName).toBe("STRONG");
    expect(screen.getByText("I=U/R").tagName).toBe("CODE");
    expect(screen.getByText("慢慢来").tagName).toBe("EM");
    expect(screen.getByTestId("root").textContent).toBe("先关燃气，公式是 I=U/R，慢慢来。");
  });

  it("代码块整段原样保留，不当成正文折行", () => {
    show("例子：\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n");
    const pre = screen.getByTestId("root").querySelector("pre");
    expect(pre?.textContent).toBe("const a = 1;\nconst b = 2;");
    expect(pre?.getAttribute("data-lang")).toBe("ts");
    expect(screen.getByTestId("root").textContent).not.toContain("```");
  });

  it("无序与有序列表各成列表，条目文字不含项目符号", () => {
    show("- 关燃气\n- 带应急包\n\n1. 走安全通道\n2. 到集合点");
    const root = screen.getByTestId("root");
    expect(root.querySelectorAll("ul")).toHaveLength(1);
    expect(root.querySelectorAll("ol")).toHaveLength(1);
    expect([...root.querySelectorAll("li")].map((li) => li.textContent))
      .toEqual(["关燃气", "带应急包", "走安全通道", "到集合点"]);
  });

  it("标题行排成强调行，井号不留在文字里", () => {
    show("### 疏散四步\n\n第一步是关燃气。");
    const heading = screen.getByText("疏散四步");
    expect(heading.tagName).toBe("P");
    expect(heading.className).toContain("companion-md__heading");
    expect(screen.getByTestId("root").textContent).not.toContain("###");
  });

  it("不吞 HTML：模型给出的尖括号内容只作为文字出现", () => {
    show('看这个 <img src=x onerror="alert(1)"> 和 <script>alert(2)</script>');
    const root = screen.getByTestId("root");
    expect(root.querySelectorAll("img")).toHaveLength(0);
    expect(root.querySelectorAll("script")).toHaveLength(0);
    expect(root.textContent).toContain('<img src=x onerror="alert(1)">');
  });

  it("流式半截（标记没闭合）照字面显示，不吞字也不整段变粗", () => {
    show("这一步要**先关燃气");
    expect(screen.getByTestId("root").textContent).toBe("这一步要**先关燃气");
  });

  it("星号用于乘法时不被当成斜体标记", () => {
    show("面积 = 长 * 宽 * 高");
    expect(screen.getByTestId("root").textContent).toBe("面积 = 长 * 宽 * 高");
  });

  it("气泡用的纯文本投影去掉标记，但保留行结构（驱动器数的是字符）", () => {
    expect(plainCompanionBubbleText("### 疏散四步\n\n**先关燃气**，再 `带应急包`。"))
      .toBe("疏散四步\n\n先关燃气，再 带应急包。");
    // 没闭合的标记按字面留着，不吞掉半句话
    expect(plainCompanionBubbleText("这一步要**先关燃气")).toBe("这一步要**先关燃气");
  });

  it("真实学习回复的独立/行内公式共享 KaTeX，粗体里的公式也能排版", () => {
    show("先看电功率：\n\n$$\nP = UI\n$$\n\n其中 $I=\\frac{P}{U}$，**这次用 $P=UI$**。");
    expect(screen.getAllByRole("math").map(node => node.getAttribute("aria-label")))
      .toEqual(["P = UI", "I=\\frac{P}{U}", "P=UI"]);
    expect(screen.getByTestId("root").querySelectorAll(".katex")).toHaveLength(3);
    expect(screen.getByTestId("root").querySelector(".mfrac")).not.toBeNull();
    expect(screen.getByTestId("root").querySelector("strong .note-math")).not.toBeNull();
  });

  it("流式公式、美元金额和代码保留内容；错误 TeX 原文可核对", () => {
    show("价格 $100 和 $200；`$P=UI$`；还在写 $$ P = UI；转义 \\$x\\$。");
    expect(screen.queryAllByRole("math")).toHaveLength(0);
    expect(screen.getByTestId("root").textContent).toContain("价格 $100 和 $200");
    expect(screen.getByText("$P=UI$").tagName).toBe("CODE");
    cleanup();
    show("$$ \\broken{x} $$");
    expect(screen.getByTestId("root").querySelector(".note-math-error")?.textContent).toBe("$$ \\broken{x} $$");
  });

  it("公式不能创建链接/脚本，过长输入保留原文而不进入排版", () => {
    show("$\\href{javascript:alert(1)}{x}$\n\n$$ \\htmlClass{onerror}{x} $$\n\n$" + "a".repeat(10_001) + "$");
    const root = screen.getByTestId("root");
    expect(root.querySelector("a, script, img, [onerror]")).toBeNull();
    expect(root.querySelector(".note-math-error")?.textContent).toContain("a".repeat(10_001));
  });

  it("引用、嵌套列表、删除线和分隔线保留各自层级", () => {
    show("> **注意**\n> 需要重新核对。\n\n3. 第一步\n   - 核对 $P=UI$\n   - ~~旧结论~~\n4. 第二步\n\n---");
    const root = screen.getByTestId("root");
    expect(root.querySelector("blockquote strong")?.textContent).toBe("注意");
    expect(root.querySelector("ol")?.getAttribute("start")).toBe("3");
    expect(root.querySelector("ol > li > ul")?.children).toHaveLength(2);
    expect(root.querySelector("del")?.textContent).toBe("旧结论");
    expect(root.querySelector("hr")).not.toBeNull();
  });

  it("表格使用公共语法，格内转义竖线不增列，公式和真实链接保持可用", () => {
    show("| 项目 | 说明 |\n| --- | --- |\n| a\\|b | **电功率** $P=UI$ |\n| 来源 | [手册](https://example.com) |");
    const table = screen.getByRole("table");
    expect([...table.querySelectorAll("th")].map(cell => cell.textContent)).toEqual(["项目", "说明"]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table.querySelectorAll("tbody tr")[0].children).toHaveLength(2);
    expect(table.querySelector("td")?.textContent).toBe("a|b");
    expect(screen.getByRole("math").getAttribute("aria-label")).toBe("P=UI");
    fireEvent.click(screen.getByText("手册"));
    expect(opened).toEqual(["https://example.com"]);
    expect(screen.getByRole("region", { name: "回复中的表格" }).tabIndex).toBe(0);
  });

  it("轻气泡不念闭合公式标记，半截标记和乘法仍按原文保留", () => {
    expect(plainCompanionBubbleText("**用 $P=UI$**，再看 $I=\\frac{P}{U}$。"))
      .toBe("用 P=UI，再看 I=\\frac{P}{U}。");
    expect(plainCompanionBubbleText("面积 = 长 * 宽 * 高；还在写 $P=UI"))
      .toBe("面积 = 长 * 宽 * 高；还在写 $P=UI");
    expect(plainCompanionBubbleText("__先看这里__")).toBe("先看这里");
  });

  it("真实交付中的双重编码换行排成段落/列表，代码与 TeX 不被改写", () => {
    show("第一段已做好。\\n\\n- **速看**已保存\\n- 卡片待审核\\n\\n代码是 `\\n\\n`，公式 **$\\nabla f$**。");
    const root = screen.getByTestId("root");
    expect(root.querySelectorAll("ul li")).toHaveLength(2);
    expect(root.querySelectorAll("p")).toHaveLength(2);
    expect(root.querySelector("code")?.textContent).toBe("\\n\\n");
    expect(screen.getByRole("math").getAttribute("aria-label")).toBe("\\nabla f");
    expect(plainCompanionBubbleText("已做好。\\n\\n下一步由你选。"))
      .toBe("已做好。\n\n下一步由你选。");
  });

  it("只有代码里的换行示例或一条普通字面转义，不触发正文解码", () => {
    show("解释 `\\n\\n`，这里只写 \\n；\n\n```js\nconst text = '\\n\\n';\n```");
    const root = screen.getByTestId("root");
    expect(root.textContent).toContain("这里只写 \\n；");
    expect(root.querySelector("pre")?.textContent).toBe("const text = '\\n\\n';");
  });

  it("混有编码段落时，跨行公式里的 nabla 命令仍是原始 TeX", () => {
    show("独立公式：\n$$\n\\nabla f\n$$\n\n已做好。\\n\\n下一步由你选。");
    expect(screen.getByRole("math").getAttribute("aria-label")).toBe("\\nabla f");
    expect(screen.getByText("下一步由你选。").tagName).toBe("P");
  });
});

describe("链接（方案 35 F7）", () => {
  it("http 链接不再吐 markdown 原文：标签与去处都看得见", () => {
    show("详见[疏散手册](https://example.com/a)：");
    const root = screen.getByTestId("root");
    expect(screen.getByText("疏散手册").tagName).toBe("SPAN");
    expect(screen.getByText("https://example.com/a").tagName).toBe("SMALL");
    expect(root.textContent).not.toContain("](");
    expect(root.querySelector("a")).toBeNull();
    // 不画 `<a>` 是刻意的：应用内永远不导航出去（主进程 will-navigate 拦外链），
    // 点了要交给系统浏览器，那是一颗按钮该干的事，不是一条导航链接。
  });

  /** 画成能点的，是因为真能点开：这条用例钉的就是"点了确实把地址交出去了"。 */
  it("点击链接：原样的地址交给打开通道，不重新拼、不截断", () => {
    show("详见[疏散手册](https://example.com/a?x=1&y=2)");
    const control = screen.getByText("疏散手册").closest("button");
    expect(control?.tagName).toBe("BUTTON");
    fireEvent.click(control as HTMLButtonElement);
    expect(opened).toEqual(["https://example.com/a?x=1&y=2"]);
  });

  it("非 http(s) 的 scheme 不解析成结构，照字面留成文字", () => {
    show("坏链接 [点我](javascript:alert(1))");
    const root = screen.getByTestId("root");
    expect(root.querySelector(".companion-md__link")).toBeNull();
    expect(root.textContent).toContain("[点我](javascript:alert(1))");
  });

  it("链接与加粗混排时两种标记都成立（组号错位会立刻露出来）", () => {
    show("先**关燃气**，再看[手册](https://e.com/x)");
    const root = screen.getByTestId("root");
    expect(screen.getByText("关燃气").tagName).toBe("STRONG");
    expect(screen.getByText("手册").tagName).toBe("SPAN");
    expect(root.textContent).toBe("先关燃气，再看手册https://e.com/x");
  });

  it("气泡那侧仍然只留标签：朗读不该念 URL", () => {
    expect(plainCompanionBubbleText("详见[疏散手册](https://example.com/a)")).toBe("详见疏散手册");
  });
});
