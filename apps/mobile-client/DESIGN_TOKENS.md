# 手机端共用视觉与动效参数

2026-10-15。iOS 为构图与动效标尺，Android 保持同一语义和比例；不使用系统默认控件外观作为设计完成的依据。

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

## 动效

| 用途 | iOS | Android | 减少动态 |
| --- | --- | --- | --- |
| 按压 | press spring 0.22s / bounce .06，轻缩放 | damping .94 / stiffness 255；自绘短按 130ms | 透明度反馈 |
| 页面进退 | spring .32s / bounce .06 | damping .94 / stiffness 120 | 短淡入 |
| 模式与菜单 | spring .38s / bounce .08 | damping .92 / stiffness 85 | 淡入就位 |
| 菜单逐项间隔 | 24ms | 24ms | 无延迟 |
| 资料飞入伴星 | 520ms 曲线飞行 | 520ms 曲线飞行 | 无位移 |
| 音频电平采样 | 40ms | 40ms | 静态波形 |
| 粒子 | 144 个确定性粒子，约 30fps | 144 个确定性粒子，跟随帧时钟 | 无粒子循环 |

时序表示实现参数，不代表已经达到 60/120fps。快速反向、重复输入、取消和后台切换必须按实际运行检查。不要把原型中“选区飞抵／逐字替换／全套共享元素”的目标文案当作当前已实现证据。

## Authentication override — 2026-10-15

White canvas, official icon only, no companion illustration. Ordinary neutral glass replaces the iridescent image concepts and iOS system glass button styles. Shared light surfaces also lose the ambient color gradients and directional sheen. Authentication field/submit heights are 56 pt/dp minimum, with 26/28 pt/dp corners; back controls are 44 pt/dp. Six verification cells use 16 pt/dp corners, 58 pt/dp height and 8 pt/dp gaps. Authentication is always light; signed-in dark tokens are retained. The implementation and current verification limits are recorded in [the authentication implementation review](../../docs/testing/mobile-auth-white-glass-2026-10-15.md).

## Authentication state and navigation refinement — 2026-10-15

Enabled submit controls use a soft blue glass tint (`actionFill` #8DB8F4 at 82%) with dark ink text; unavailable controls remain neutral grey. Loading retains the active tint with a progress indicator. Submit buttons have no right-arrow decoration.

Authentication uses one persistent composition instead of whole-page push/pop replacements. The official icon stays visible and the same brand group translates 56 pt/dp and scales to 94% when entering a child step; it reverses on return. Titles and newly added content use a small directional transition. Email/password controls keep stable field identities, and the same submit control follows the form reflow. Android mirrors the shared field identities using keyed visibility and animated form layout. The shared authentication curve is (0.23, 1, 0.32, 1) over 260 ms, with a 160 ms opacity transition. Reduced motion uses opacity without page displacement. Repeated forward/back actions remain available throughout the transition.
