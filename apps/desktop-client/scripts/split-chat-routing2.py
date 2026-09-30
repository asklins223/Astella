"""按 **AST 精确区间**把 `companion-chat-session.tsx` 的纯函数抽出去。

区间来自 `split-chat-routing-probe.test.ts`（`node.getStart()` 含 JSDoc，`getEnd()` 到函数尾）。
**不用行号算术**——在这份文件上它栽了两次：一次把 JSDoc 的 `/**` 留在原文件
（新文件从 `* …` 开始，解析直接报 `Expression expected`），
一次把区间短成「只有那段 JSDoc」（函数体全留在原文件，报 `Cannot redeclare`）。
"""
import io
import json
import re

SRC = "src/renderer/src/app/companion-chat-session.tsx"
DST = "src/renderer/src/app/companion-chat-routing.ts"

src = io.open(SRC, encoding="utf-8").read()
spans = json.load(io.open("/tmp/r52-spans.json", encoding="utf-8"))
MOVE = [n for _, _, n in spans]
assert len(MOVE) == 8 and not any(spans[i][0] < spans[i - 1][1] for i in range(1, len(spans)))

blocks = [src[a:b].rstrip() for a, b, _ in spans]
body = "\n\n".join(blocks) + "\n"

# ① 顶部 import：整份抄过来（宁可多，别漏）
L = src.split("\n")
imports, i = [], 0
while i < len(L) and (L[i].startswith("import ") or L[i].strip() == ""):
    if L[i].startswith("import "):
        j = i
        while not L[j].rstrip().endswith(";"):
            j += 1
        imports.append("\n".join(L[i:j + 1]))
        i = j + 1
    else:
        i += 1

header = '''/**
 * 伴星会话的**派生逻辑**（2026-09-30 从 `companion-chat-session.tsx` 抽出）。
 *
 * ## 为什么抽
 *
 * 那个文件里原本混着两件毫不相干的事：**Provider**（取数 + 状态机 + 发消息）
 * 与**纯函数**（路由怎么落、文案怎么拼、nav chip 该不该留在消息外面、
 * 两个错误怎么映射成人话）。后者**一个 hook 都没有**，却占了两百多行——
 * 读 Provider 的人要一路滑过去，才知道它其实不碰状态。
 *
 * 判据就是 AGENTS.md 那句「页面组件只做四件事：取数、派生、摆位、接事件」：
 * **派生该有自己的地方。**
 *
 * ## 拆的是位置，不是行为
 *
 * 函数体**一个字没改**。原来靠同文件顶层可见的依赖这里显式 import；
 * 原来在本文件声明的类型从 `companion-chat-session` 取——**单向依赖**，不成环。
 *
 * ## 搬运必须按 AST 区间，不能按行号算术
 *
 * 两次栽在同一个地方：手算「从 JSDoc 起、到下一个顶层声明止」的区间，
 * 一次把 `/**` 留在原文件（新文件从 `* …` 开始 → `Expression expected`），
 * 一次把区间短成只有那段 JSDoc（函数体全留下 → `Cannot redeclare`），
 * **而报错行号离真因几百行**。`node.getStart()` / `node.getEnd()` 不会。
 */

'''

io.open(DST, "w", encoding="utf-8").write(header + "\n".join(imports) + "\n" + body)
print("  搬走 %d 个纯函数 → %s" % (len(MOVE), DST))

# ② 原文件：删掉这八段，换成「导入 + 再导出」
drop = set()
for a, b, _ in spans:
    drop.update(range(src[:a].count("\n"), src[:b].count("\n") + 1))
kept = [l for i, l in enumerate(L) if i not in drop]
rest = "\n".join(kept)
still = [n for n in MOVE if re.search(r"\b" + n + r"\b", rest)]

marker = next(i for i, l in enumerate(kept) if l.startswith("const CompanionChatContext"))
block = [
    "// 纯函数（路由落点 / 文案 / nav chip 可见性 / 两个错误映射）在 `companion-chat-routing.ts`——",
    "// 它们一个 hook 都没有，留在 Provider 文件里只是当初图省事。",
]
if still:
    block.append("// 本文件内部也要调其中几个，所以是「导入 + 再导出」。")
    block.append('import { %s } from "./companion-chat-routing";' % ", ".join(still))
block.append('export { %s } from "./companion-chat-routing";' % ", ".join(MOVE))
kept[marker:marker] = block + [""]
io.open(SRC, "w", encoding="utf-8").write("\n".join(kept))
print("  原文件仍在用：%s" % (", ".join(still) or "（无）"))
print("  %s：%d → %d 行" % (SRC, len(L), len(kept)))
