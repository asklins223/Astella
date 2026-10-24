# DS鲸鱼娘（DS鼠控版）

- 来源：用户（Owner）2026-09-20 提供，`DS鲸鱼娘.zip`（DS鼠控版）。
- 模型作者：B站 @氵六青（11272072），无偿分享模型。
- 作者许可（《使用须知.txt》）：商用直播 √、自印物料 √；禁止任何形式的盗用以及出售。
- 集成时的整理（2026-09-20）：
  - 只保留运行时需要的文件：`c_0120.moc3`、双 2048 纹理、物理、cdi3 与 `motions/`、`expressions/`，
    并剔除 `.zip`、`.DS_Store`、`items_pinned_to_model.json` 和 `c_0120.vtube.json`（VTube Studio 配置）。
  - 原始 `c_0120.model3.json` 未声明任何 Motions/Expressions 组，且 LipSync 组为空；
    运行时副本补上动作组、ASCII 别名表情与 `ParamMouthOpenY` 口型组。
    口型参数：该模型没有 `ParamA`，口型写 `ParamMouthOpenY`（见 `window-live2d-contract.ts` 注册表）。
  - 表情文件名保留中文原名，`model3.json` 里的 `Name` 用 ASCII 别名，避免 URL/转义问题。
- 2026-10-24 用户确认桌面与 iOS 补齐完整动作，覆盖此前排除桌面道具与发型的决定。
  模型默认就有点菜板与桌面，旧说明中“没有桌子”的判断不成立。
- 当前接入范围：原包 **7 条动作、44 个表情／道具全部接入**；另有 3 段记笔记组合，
  总计 10 段动作。除 Idle 外的 9 段动作与 44 个表情／道具进入同一个无重复洗牌池。
  - 补回 `PhoneOpen`（开盖）与 `Ketchup`（挤番茄酱）；原作者曲线保留，只将非 Idle 的
    `Meta.Loop` 设为 false，避免重复表演或道具滞留。
  - `TakingNotes` 有桌面鲸鱼、闭眼笑＋头顶鲸鱼、眼镜＋头顶鲸鱼三种组合。复用模型已有
    点菜板与手部控制参数，不增加图片、模型或渲染循环。
  - 14 个补回的表情／道具包含蛋包饭、挤酱、点按／画笔／橡皮／撤回、桌布、饮料及换色、
    手机换色、鲸鱼上桌、芭菲开关与临时发型。它们限时播放后恢复，不永久修改形象。
  - 四个需要前置物件的变体在 `presets/` 中组合原始参数：挤酱带蛋包饭、手机换色带手机、
    饮料换色带饮料、鲸鱼上桌先显示鲸鱼。`expressions/` 保留原包 44 个文件。
- `node scripts/sync-companion-performances.mjs` 从本目录原始表达式生成依赖组合、记笔记动作、
  model3 注册和 SHA-256 清单；`--check` 检查是否同步。不要直接编辑生成的 `presets/` 与
  `motions/taking-notes*.motion3.json`。桌面打包使用本目录，iOS 通过既有模型分发与版本缓存下载同一份。
- 本轮调用链、窗口验证和分发范围见 [完整动作记录](../../../../../../../../../docs/testing/companion-full-performances-2026-10-24.md)。
- 完整 SHA-256 清单见同目录 `manifest.json`。原作者的《使用须知.txt》《按键表.txt》
  保存在用户提供的原目录（`~/Downloads/DS鲸鱼娘/`），本目录以 `manifest.json` 记录许可要点。
