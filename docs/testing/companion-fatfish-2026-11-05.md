# 桌面端大肥鱼（fatfish）形象核对（2026-11-05）

范围：桌面客户端与 iOS 共用的 Live2D 资产整理、三档体型取值与桌面运行路径。iOS 侧完整的逐帧实测、截图与安装包验收见手机仓库 `docs/testing/ios-companion-fatfish-2026-11-05.md`。

## 体型取值

moc3 里一根 0…1 的 `Clothes2` 滑杆拆成三档：

| 档位 | `Clothes2` |
| --- | --- |
| 小（默认） | 1.0 |
| 中 | 0.4 |
| 大 | 0.05 |

**不能用 0**：`Part46「鼻子」`（ArtMesh246 / ArtMesh682）在 `Clothes2 === 0` 时画出的是一块纯黑贴图，作者只给另外两档做了透明。0.05 是鼻子不再发黑的最小干净值。

## 资产与生成

资产位于 `apps/desktop-client/src/renderer/public/assets/companion/live2d-v4/fatfish/`，由 `apps/desktop-client/scripts/build-companion-fatfish.mjs` 从作者原包规范化生成：

- 文件名改为 ASCII，避免 URL 转义；
- `model3.json` 补 `Expressions`（ASCII 别名 → 中文文件）与 `Motions` 组；
- `Groups` 补 EyeBlink（`ParamEyeLOpen` / `ParamEyeROpen`）与 LipSync（`ParamMouthOpenY`）；
- `manifest.json` 记录许可、来源、运行时路径与每份文件的 SHA-256。

作者原包不随仓库分发。

## 许可

作者《使用须知》允许个人直播、视频创作与平台收益、参数调整与个人二创；禁止重新分发模型文件、二次销售与冒充原作者。Owner 2026-11-05 裁决按可商用登记，与既有鲸鱼娘同一口径。公开署名：原画 神宫凉子 / 建模 霓虹猫_NeonNeko。

## 桌面行为

- 默认形象仍是 whale；fatfish 在设置里可选。
- 桌面上 whale 始终整身；fatfish 只在首页全身，其余页面用上半身窗口。
- 带 `*Back` 的释放动作在正向动作之后播放，播放一次回到原动作。
