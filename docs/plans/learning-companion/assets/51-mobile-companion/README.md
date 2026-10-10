# 方案 51 · 随身伴星交互设计与实施约束

日期：2026-10-10。当前交付是可操作的浏览器布局稿与真实截图，移动客户端及业务互通尚未实现。

## 当前方向

用户连续指出生成图的固定风景区占空间、玻璃不足、伴星被缩成图标。本轮直接在 HTML/CSS 中排版：书房底图铺在整个界面下方，居中的伴星来自现有 Live2D 模型的静态取帧；聊天透色，阅读有更厚的磨砂面。背景不再单独占一段高度。

![实际页面：交流、键盘展开、阅读](08-layout-chat-keyboard-reading.png)

1. **连续交流**：120px 宽的伴星、姓名签和两侧入口；原话、查阅状态、答复与成果在同一份滚动内容中。
2. **键盘展开**：角色改为 78px 宽、姓名签移到侧边，顶部收短；输入正常占位，不覆盖聊天。键盘为 292px 的布局占位。
3. **长文阅读**：94px 宽的伴星仍可辨认，正文大面使用更厚的磨砂底；段落能一直滚到最后，底部输入可就近追问。

![实际页面：材料、修改、小程序](09-layout-upload-edit-miniprogram.png)

4. **材料处理**：长文件名、解析状态、停止、图片引用和已有成果在同一页；当前进展不假称已经读完。
5. **修改与对照**：原文和表格可以真实切换，撤回仅作用于本机样例；正式能力须接保存版本与操作回执。
6. **小程序布局**：复用同一页面与状态逻辑，宿主胶囊另行留位；图中胶囊为占位，正式使用宿主给出的边界。

## 打开与复现

- 可交互稿：[mobile-companion-layout.html](../../../../../apps/desktop-client/demos/mobile-companion-layout.html)
- 页面样式：[mobile-companion-layout.css](../../../../../apps/desktop-client/demos/mobile-companion-layout.css)
- 同一份状态逻辑：[mobile-companion-layout.js](../../../../../apps/desktop-client/demos/mobile-companion-layout.js)
- 浏览器检查与截图脚本：[capture-mobile-companion-layout.mjs](../../../../../apps/desktop-client/demos/capture-mobile-companion-layout.mjs)
- 现有模型取帧页：[mobile-companion-character.html](../../../../../apps/desktop-client/demos/mobile-companion-character.html)
- 当前环境预览：[打开本机预览](http://127.0.0.1:4196/demos/mobile-companion-layout.html)

从项目根目录启动预览：

```sh
python3 -m http.server 4196 --bind 127.0.0.1 --directory apps/desktop-client
```

检查脚本从 desktop-client 包运行，默认使用已安装的 Playwright 浏览器；浏览器路径不同可用 ASTELLA_LAYOUT_BROWSER 指定现有可执行文件：

```sh
cd apps/desktop-client
node demos/capture-mobile-companion-layout.mjs
```

界面外的评审控件可切六种状态、四种屏幕尺寸、三档正文字号和无模糊降级。board=1 / board=2 页面由同一组件生成，作为六屏截图来源。

## 实际空间与交互

以 390×844 为参考，状态栏 44px、底部安全区 24px。交流顶部 132px，阅读顶部 100px，键盘态顶部 76px；短屏键盘态再收为 52px。背景为底层图，不参与高度分配。输入框随草稿增长，短屏键盘态最高 62px，多余内容在输入框内滚动。

正文、顶栏和输入区由 flex 正常布局划分，内容独立滚动。没有常驻底部导航行，材料、事项和历史从菜单、“＋”及手记进入。主操作按钮热区至少 44×44px，角色入口不盖小程序胶囊。

已检查 54 组：390×844、360×720、320×640 × 正文字号 100%、125%、150% × 六种状态。最小正文空间为 320×640 键盘态的 172px；其他状态详见 [几何与检查记录](layout-verification-2026-10-10.json)。输入草稿往返笔记保持，长文可滚到底，修改前后可切换，消息可加入本机样例，停止可改变本机任务状态。原型在 Chromium 自动检查与 Codex 内置浏览器中查看、操作。

## 从设计稿到移动组件

| 元素 | 实施依据 |
| --- | --- |
| 环境 | 复用现有灯塔书房静态底图，铺在全界面底层；不需要 3D 渲染或独立风景栏 |
| 伴星 | 静态取帧来自已登记的 whale v3 模型；布局先与动画解耦，正式 App／小程序运行时分别验证 |
| 玻璃 | 半透明浅底、亮边、内高光、短阴影和局部背景模糊；不依赖折射、液体模拟、物理光照 |
| 内容面 | 聊天面约七成白，阅读面约九成白，正文深色；无模糊时改用更实的浅底 |
| 滚动性能 | 当前模型为静态图；正式宿主须验证角色动画与磨砂大面的合成成本，必要时降低模糊与环境细节 |
| 输入与播放 | 同一底栏按状态切换，键盘高度与安全区来自宿主；草稿和上下文不因切页丢失 |
| 宿主胶囊 | 产品控件避让宿主真实边界，不重画系统胶囊 |
| 服务与数据 | 消息、任务、文件、版本均接方案 51 的同一业务身份；这份原型没有连接账号或业务服务 |

这些浏览器检查证明布局和本机交互能运行，不能证明软键盘、原生性能、Live2D、音频、文件解析、图片圈选或跨端实时聊天已接通。文件选择只读文件名，不上传；播放为显示状态，不发声音。

完整行为与数据合同见 [产品方案 51](../../51-mobile-companion-full-agent-product-design-2026-10-10.md)。

## 前序探索

以下图稿保留来由，当前方向以 08、09 的真实页面截图为准：

- [前一轮玻璃交流与材料](06-glass-home-chat-materials.png)，[生成提示词 06](prompts/06-glass-home-chat-materials.txt)
- [前一轮玻璃阅读与圈问](07-glass-reading-edit-photo.png)，[生成提示词 07](prompts/07-glass-reading-edit-photo.txt)
- [常规交流与上传](04-practical-home-chat-upload.png)，[生成提示词 04](prompts/04-practical-home-chat-upload.txt)
- [常规阅读与修改](05-practical-reading-edit-photo.png)，[生成提示词 05](prompts/05-practical-reading-edit-photo.txt)
- [早期伴星预览讲解](companion-first.png)

04—07 使用内置 image_gen 和 imagegen 技能生成。08—09 直接截图真实 HTML/CSS 页面，没有生成式界面提示词。角色取帧保存为 [companion-model-neutral.png](companion-model-neutral.png)，由项目本机模型绘制。
