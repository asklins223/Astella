# 手机端共用视觉与动效参数

## Current platform motion direction — 2026-10-18

Keep shared meaning and visual hierarchy, while using each platform's own animation model. iOS uses SwiftUI-native navigation, matched geometry, springs and sensory feedback. Android uses Compose springs tuned for Android distances and its interaction model. These values are platform starting points, not a conversion table; judge the feel in a running app and retune when needed.

| Use | iOS | Android | Reduced motion |
| --- | --- | --- | --- |
| Press | Native SwiftUI button feedback with a short spring | Compose spring (`damping .94`, `stiffness 255`) | Keep the action; remove scale motion |
| Page navigation | `NavigationStack` and native note zoom transition | Compose route spring (`.92`, `260`) with directional slide | Snap or brief opacity only |
| Dock selection | SwiftUI snappy spring (`.32s`, `extraBounce .03`) and matched selection surface | Compose spring (`.88`, `380`) on a shared selection surface | Place selection immediately |
| Companion shortcut | SwiftUI spring and opacity/scale transition | Compose spring with restrained expand, scale and opacity | Place or remove immediately |

Fast retargeting, reversals, canceled gestures and backgrounding still need checks in real application windows. Numeric values describe the current implementation; they do not establish a frame-rate guarantee.

## Historical shared visual decisions — 2026-10-15

The prior design treated iOS as the numeric motion ruler for Android. That cross-platform coupling is superseded by the 2026-10-18 platform-specific direction above. Shared color, typography, glass and layout tokens below remain current unless a later product decision changes them.

## 色彩

| 语义 | 浅色 | 深色 |
| --- | --- | --- |
| ink | #27334B | #EDF2FF |
| muted | #66758A | #9AA9C2 |
| accent | #5A7CD1 | #A9C2FF |
| sky | #E5EEFF | #263B60 |
| canvas | #FFFFFF | #101827 |
| paper | #FFFFFF | #1C2B43 |
| inset | #F3F5F8 | #283A55 |
| paperEdge | #DDE2E9 | #3D5274 |

玻璃采用自定连续形状，模糊约 22pt/dp，低透明染色、0.8pt/dp 均匀中性细描边；禁用噪点纹理。输入区圆角 22、快捷动作 18、菜单 24、导航 29。文字优先使用清楚的无衬线字阶，不用装饰性英文编号和衬线大标题。基础正文 16–17，辅助说明 12–13，主标题 29–30。系统字体缩放与阅读缩放仍需独立验证。

## 动效验收

上方的平台动效矩阵是当前参数来源；本节不再把旧版“iOS 参数直接映射到 Android”的表格当成实现合同。真实窗口验收覆盖快速反向、重复输入、拖动取消、键盘开合、系统返回、后台切换与减少动态；焦点与操作不等待动画结束。若动画没有提供空间或状态信息，就保持即时变化。时间参数不代表已经达到 60/120 fps，设备帧率仍需在目标真机测量。

## Authentication override — 2026-10-15

White canvas, official icon only, no companion illustration. Ordinary neutral glass replaces the iridescent image concepts and iOS system glass button styles. Shared light surfaces also lose the ambient color gradients and directional sheen. Authentication field/submit heights are 56 pt/dp minimum, with 26/28 pt/dp corners; back controls are 44 pt/dp. Six verification cells use 16 pt/dp corners, 58 pt/dp height and 8 pt/dp gaps. Authentication is always light; signed-in dark tokens are retained. The implementation and current verification limits are recorded in [the authentication implementation review](../../docs/testing/mobile-auth-white-glass-2026-10-15.md).

## Authentication state and navigation refinement — 2026-10-15

Enabled submit controls use a soft blue glass tint (`actionFill` #8DB8F4 at 82%) with dark ink text; unavailable controls remain neutral grey. Loading retains the active tint with a progress indicator. Submit buttons have no right-arrow decoration.

Authentication uses one persistent composition instead of whole-page push/pop replacements. The official icon stays visible and the same brand group translates 56 pt/dp and scales to 94% when entering a child step; it reverses on return. Titles and newly added content use a small directional transition. Email/password controls keep stable field identities, and the same submit control follows the form reflow. Android mirrors the shared field identities using keyed visibility and animated form layout. The shared authentication curve is (0.23, 1, 0.32, 1) over 260 ms, with a 160 ms opacity transition. Reduced motion uses opacity without page displacement. Repeated forward/back actions remain available throughout the transition.
