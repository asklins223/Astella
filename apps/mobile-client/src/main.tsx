import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans-sc/wght.css'
import '@fontsource-variable/noto-serif-sc/wght.css'
/* 层序是刻意的：先垫我们自己的（只服务 demo 里没有的部分：她的 markdown 回复、
 * 批注高亮、脑图与讲解画框），再让 prototype 那四张按它自己的顺序盖上来
 * （layout → centers → scene → theme），最后 app.css 负责整屏壳与手指命中区。
 * 同名的一律以 prototype 为准。 */
import './styles/tokens.css'
import './styles/base.css'
import './styles/conversation.css'
import './styles/notes.css'
import './styles/demo/mobile-companion-layout.css'
import './styles/demo/mobile-companion-centers.css'
import './styles/demo/mobile-companion-scene.css'
import './styles/demo/mobile-companion-theme.css'
import './styles/app.css'
import './styles/run-process.css'
import './styles/motion.css'
import './styles/page-refinements.css'
import './styles/context-companion.css'
import { App } from './app/App.tsx'

// StrictMode 会把挂载跑两遍：伴星的画布与事件流都必须能在"挂—卸—再挂"下
// 干净重来，这条从一开始就是刻意留的，不是调试残留。
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
