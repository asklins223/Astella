import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_FRAME_ORIGIN,
  ARTIFACT_FRAME_SANDBOX,
  artifactFrameMotionMessage,
  artifactFrameUrl,
  isArtifactFrameUrl,
  isArtifactId,
  parseArtifactFrameEvent
} from './artifact-frame'

const ID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'

describe('产物 frame 的契约（D4 §3.2、§4.3）', () => {
  it('sandbox 只给 allow-scripts，且绝不与 allow-same-origin 同时出现', () => {
    expect(ARTIFACT_FRAME_SANDBOX).toBe('allow-scripts')
    // D4 §7.4 的红线：那个组合下 frame 能自己摘掉沙箱属性。
    expect(ARTIFACT_FRAME_SANDBOX.split(/\s+/)).not.toContain('allow-same-origin')
    for (const forbidden of [
      'allow-forms',
      'allow-popups',
      'allow-modals',
      'allow-downloads',
      'allow-presentation',
      'allow-pointer-lock'
    ]) {
      expect(ARTIFACT_FRAME_SANDBOX.split(/\s+/)).not.toContain(forbidden)
    }
    expect(ARTIFACT_FRAME_SANDBOX.split(/\s+/)).not.toContain('allow-top-navigation')
  })

  it('产物 URL 只认 uuid，凭据／端口／多段路径一律不算产物', () => {
    expect(isArtifactFrameUrl(artifactFrameUrl(ID))).toBe(true)
    expect(artifactFrameUrl(ID)).toBe(`${ARTIFACT_FRAME_ORIGIN}/${ID}`)

    expect(isArtifactFrameUrl(`${ARTIFACT_FRAME_ORIGIN}/not-a-uuid`)).toBe(false)
    expect(isArtifactFrameUrl(`${ARTIFACT_FRAME_ORIGIN}/`)).toBe(false)
    expect(isArtifactFrameUrl(`${ARTIFACT_FRAME_ORIGIN}/../bundle/index.html`)).toBe(false)
    expect(isArtifactFrameUrl(`ailearn-app://user:pw@artifact/${ID}`)).toBe(false)
    expect(isArtifactFrameUrl(`ailearn-app://artifact:8443/${ID}`)).toBe(false)
    expect(isArtifactFrameUrl(`https://artifact/${ID}`)).toBe(false)
    // 主页面 origin 不是产物 origin——这一条是"产物想把自己导航到主页面"那一发的反面对着。
    expect(isArtifactFrameUrl('ailearn-app://bundle/index.html')).toBe(false)
  })

  it('id 形状就是路径安全的那道闸：uuid 之外没有东西可拼进路径', () => {
    expect(isArtifactId(ID)).toBe(true)
    expect(isArtifactId('../bundle/index')).toBe(false)
    expect(isArtifactId(`${ID}/../../etc/passwd`)).toBe(false)
    expect(isArtifactId(`${ID}\u0000`)).toBe(false)
    expect(() => artifactFrameUrl('../../etc/passwd')).toThrow()
  })

  it('父侧只认通道名与方向都对的、阶段在白名单里的消息', () => {
    expect(parseArtifactFrameEvent({
      channel: 'ailearn:artifact-frame',
      direction: 'frame->host',
      phase: 'ready',
      stepCount: 3
    })).toEqual({
      channel: 'ailearn:artifact-frame',
      direction: 'frame->host',
      phase: 'ready',
      stepCount: 3
    })

    // 负对照：通道名不对／方向写反／阶段不在白名单／根本不是对象——一律忽略。
    expect(parseArtifactFrameEvent({ channel: 'x', direction: 'frame->host', phase: 'ready' })).toBeNull()
    expect(parseArtifactFrameEvent({
      channel: 'ailearn:artifact-frame',
      direction: 'host->frame',
      phase: 'ready'
    })).toBeNull()
    expect(parseArtifactFrameEvent({
      channel: 'ailearn:artifact-frame',
      direction: 'frame->host',
      phase: 'run'
    })).toBeNull()
    expect(parseArtifactFrameEvent('ailearn:artifact-frame')).toBeNull()
    expect(parseArtifactFrameEvent(null)).toBeNull()
    // 阶段对但字段类型不对：字段丢掉，消息本身仍然只是一条"还活着"。
    expect(parseArtifactFrameEvent({
      channel: 'ailearn:artifact-frame',
      direction: 'frame->host',
      phase: 'heartbeat',
      stepCount: '3'
    })).toEqual({
      channel: 'ailearn:artifact-frame',
      direction: 'frame->host',
      phase: 'heartbeat'
    })
  })

  it('宿主的 motion 指令形状固定（切静态分镜走这一条）', () => {
    expect(artifactFrameMotionMessage('reduced')).toEqual({
      channel: 'ailearn:artifact-frame',
      direction: 'host->frame',
      command: 'motion',
      motion: 'reduced'
    })
  })
})
