# 拾星笔记（Astella）— 品牌图标与产品名

产品名 2026-10-06 定为 **Astella**，中文名 **拾星笔记**。这是这个项目的第三次
定名：`AI Learn` → 「理解引擎」（2026-10-04）→ Astella／拾星笔记。

名字分两层，别混：

| 层 | 取值 | 落在哪 |
| --- | --- | --- |
| 包名／身份 | `Astella`（ASCII） | `productName`、bundle 与 exe 名、`%LOCALAPPDATA%\Programs\Astella`、产物名 `astella-<version>-…`、`appId: com.asklins.astella` |
| 显示名 | `拾星笔记` | `CFBundleDisplayName`、`nsis.shortcutName` 与 `uninstallDisplayName`、窗口标题、登录页与 /admin 面板的文案 |

2026-10-06 的第二轮改名把**内部标识也一起换掉了**：npm scope `@astella/`、preload 桥
`window.astella` / `window.astellaDesktop`、IPC 通道前缀 `astella.v1.`、环境变量
`ASTELLA_*`、自定义协议 `astella-app://`、Docker 项目名与派生的容器/卷名。
**仍保留 `astella` 的只有存储与时序标识**：Postgres 库名／角色／函数、MinIO 桶
`astella-workspaces`、Prometheus 指标名 `astella_*`——改它们是数据迁移，不是改名。

Electron 的 userData 目录取的是 package.json 的 `name`（现在是
`astella-desktop-client`），**不跟 productName 走**：换显示名不动数据，换包名才会搬。
这一点 `.github/workflows/desktop-package.yml` 里也有实测断言。

- 图标母版：`app-icon.png`，1024 × 1024，RGBA。
- 形象：宝蓝夜空里，短发女孩握着笔在蓝色笔记本上写字，旁边一枚眨眼的黄色星星。
- 来源：用户 2026-10-06 提供的图标包（APPLORE 导出），母版取其中 iOS/AppStore 的
  满幅 1024 图，**未经裁切或重绘**。同一包里 macOS 那版带留白和投影，直接拿来用
  会让 Dock 里的图标小一圈，所以只取满幅版，圆角仍由下面的统一流程处理。

## 从母版派生的三份产物

`apps/desktop-client/build/` 下是 electron-builder 真正吃进去的图标资源：

| 文件 | 用途 | 生成方式 |
| --- | --- | --- |
| `icon.png` | 1024×1024 母版，electron-builder 的兜底输入 | 本目录 `app-icon.png` 同尺寸副本 |
| `icon.icns` | macOS Dock / Finder / 安装包 | `iconutil`，11 个尺寸（16→1024，含 @2x） |
| `icon.ico` | Windows 开始菜单 / 任务栏 / 安装包 | Pillow，16/24/32/48/64/128/256 七档 |

三者都在**版本控制内**。`.gitignore` 里 `build/` 那条会挡掉它们，靠紧随其后的
`!apps/desktop-client/build/` 否定规则放行——这组规则原先写的是 `apps/desktop/`，
而本项目的应用目录叫 `apps/desktop-client/`，所以图标一直进不了仓库（详见
`.gitignore` 注释）。

## 圆角与透明

母版是**整幅满铺 + 22.37% 圆角 + 四角透明**。macOS 与 Windows 都不会替应用图标
自己裁圆角，圆角属于图标本身；提供的图是方形的（四角带着画面内容），所以统一用
上面那段脚本把四角转成透明，让 Dock、任务栏、开始菜单里都是同一枚圆角方形。

## 换图标时

改这一张母版，然后重新生成上面三份即可，`electron-builder.yml` 不用动：

```bash
# 1) 母版（圆角 + 透明）
python3 - <<'PY'
from PIL import Image, ImageDraw
S = 1024
im = Image.open("<新图>").convert("RGB").resize((S, S), Image.LANCZOS)
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S-1, S-1], radius=int(S*0.2237), fill=255)
out = im.convert("RGBA"); out.putalpha(mask)
out.save("apps/desktop-client/build/icon.png")
PY

# 2) icns（macOS 原生工具）
#    目录名必须以 .iconset 结尾，否则 iconutil 直接报 "Invalid Iconset"
rm -rf /tmp/brand.iconset && mkdir /tmp/brand.iconset
#   按上文表格的尺寸导出到 /tmp/brand.iconset/ 后：
iconutil -c icns /tmp/brand.iconset -o apps/desktop-client/build/icon.icns

# 3) ico（Windows）
python3 -c "
from PIL import Image
Image.open('apps/desktop-client/build/icon.png').save(
    'apps/desktop-client/build/icon.ico', format='ICO',
    sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
```