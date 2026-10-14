import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans-sc/wght.css'
import '@fontsource-variable/noto-serif-sc/wght.css'
import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/demo/mobile-companion-layout.css'
import '../styles/demo/mobile-companion-centers.css'
import '../styles/demo/mobile-companion-scene.css'
import '../styles/demo/mobile-companion-theme.css'
import '../styles/app.css'
import '../styles/motion.css'
import { AuthScreen } from './AuthScreen.tsx'
import { useSession } from '../state/session.ts'

/** Development entry uses the actual auth component without signing out the open book. */
function AccountPreview() {
  const session = useSession()
  return <div className="app phone" data-utility="true" data-ready="signed_out" style={{ '--text-scale': '1' } as React.CSSProperties}>
    {session.status === 'ready'
      ? <div className="welcome"><h1>已经回到书房</h1><p>账号流程使用真实服务。</p><a href="/">打开手机书房</a></div>
      : <AuthScreen />}
  </div>
}
createRoot(document.getElementById('root')!).render(<StrictMode><AccountPreview /></StrictMode>)
