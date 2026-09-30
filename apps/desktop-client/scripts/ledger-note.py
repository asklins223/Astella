"""在 `component-size-guard` 的 `SIZE_DEBT` 里，给某一条加一段说明。

## 为什么要写成脚本

上一版我用 `s.index('  "app/companion-chat-session.tsx":')` 找插入点，
**它匹配到的是 `understanding-universe.tsx` 那条字符串值里的一段**
（多行 `+ "…"` 拼接的续行里也出现了同样的字符序列）。
把注释插进去 = **把一个字符串字面量劈成两半**，
于是那个文件里的每一条测试都变成 `no tests`——而**报错完全指不到我改的那几行**。

**所以：插入点必须是「一个真正的键行」，不是「一段文本」。**
判据：行首正好两个空格、整行以 `":` 结尾、且它的下一行是该条目的值。
"""
import io
import re
import sys

p = "src/main/__tests__/component-size-guard.test.ts"
key = sys.argv[1]
note = io.open(sys.argv[2], encoding="utf-8").read()

L = io.open(p, encoding="utf-8").read().split("\n")
# 真正的键行：整行匹配 `^  "…":$`
hit = [i for i, l in enumerate(L) if re.match(r'^  "[^"]+":$', l) and f'"{key}"' in l]
assert len(hit) == 1, "键行匹配到 %d 处：%s" % (len(hit), hit)
i = hit[0]
# 往上并进这条自己的说明块（JSDoc / 注释）
a = i
while a > 0 and L[a - 1].lstrip().startswith(("*", "/*", "//")):
    a -= 1
# ⚠️ 插入的每一行**必须以 `//` 开头**。本脚本连栽两次，都是因为说明里有几行
# 写成了裸 `# `（那是 Markdown 的标题，**放进 TS 注释块里就是一个语法错误**），
# 症状是那个文件里**每一条测试都变成 `no tests`**，而报错完全指不到那几行。
# 所以在这里硬拦一道：**不注释就不让插**。
bad = [l for l in note.split("\n") if l.strip() and not l.lstrip().startswith(("//", "/*", "*", "}", "{"))]
if bad:
    sys.exit("  ✗ 这些行不是注释，先改成 `// ` 开头：%r" % bad[:2])

L[a:a] = note.rstrip("\n").split("\n")
io.open(p, "w", encoding="utf-8").write("\n".join(L))
print("  ✓ 已插在第 %d 行之前（键行在第 %d 行）" % (a + 1, i + 1 + len(note.rstrip().split("\n"))))
