import { usePrefs } from '../state/prefs.ts'
import { SceneChat } from './SceneChat.tsx'
import { ThreadChat } from './ThreadChat.tsx'

/** 两种视图共用同一段交流，只是把重心给她还是给正文。 */
export function ChatPage() {
  const prefs = usePrefs()
  return prefs.chatLayout === 'scene' ? <SceneChat /> : <ThreadChat />
}
