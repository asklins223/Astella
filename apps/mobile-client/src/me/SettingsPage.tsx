import { ParticipationPreferences } from "./ParticipationPreferences.tsx";
import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Icon } from '../app/icons.tsx'
import { usePhoneRoot } from '../app/phone-root.tsx'
import { originOf, openSheet, requestSheetClose, useSheet } from '../ui/sheet-store.ts'
import { useMotion, setLocalMotionOff } from '../platform/motion.ts'
import { setChatLayout, setTextScale, textScaleOptions, usePrefs, type ChatLayout } from '../state/prefs.ts'

/**
 * 使用设置。
 *
 * 这一屏只放**这台设备上真能改的东西**：字号落在 `--text-scale`，
 * 对话显示决定打开时先见到她还是先见到记录，减少动效让所有过渡直接就位。
 * 她的名字、表达与记忆还没接到手机上，所以这里没有那几行。
 */
export function SettingsPage({ userId }: { userId: string | undefined }) {
  const prefs = usePrefs()
  const motion = useMotion()
  const motionSource = motion.systemCalm
    ? '系统设置已要求减少动效'
    : motion.accountOff
      ? '伴星设置已要求减少动效'
      : motion.localOff
        ? '这台设备已减少动效'
        : '当前会播放过渡、流光与入场动效'
  const motionLocked = motion.systemCalm || motion.accountOff

  return (
    <section className="page-scroll utility-scroll" data-view-key="settings" aria-label="使用设置">
      <div className="utility-page settings-page">
        <div className="utility-title">
          <p className="utility-eyebrow">让学习更合你的习惯</p>
          <h1>按你的节奏</h1>
        </div>

        <p className="group-label">阅读与对话</p>
        <div className="utility-group glass settings-group">
          <div className="setting-field">
            <i className="setting-icon type-icon">Aa</i>
            <span>
              <strong>阅读字号</strong>
              <small>对话与笔记正文</small>
            </span>
            <SettingChoice
              label="阅读字号"
              value={prefs.textScale}
              options={textScaleOptions().map((option) => ({
                ...option,
                detail: option.value === 1 ? '适合日常阅读' : option.value === 1.25 ? '阅读长文更轻松' : '优先保证文字清晰',
              }))}
              onChange={(value) => setTextScale(value, userId)}
            />
          </div>
          <div className="setting-field">
            <i className="setting-icon"><Icon name="message-square-text" /></i>
            <span>
              <strong>打开时的样子</strong>
              <small>两种视图共用同一段交流</small>
            </span>
            <SettingChoice
              label="对话显示方式"
              value={prefs.chatLayout}
              options={[
                { value: 'scene', label: '伴星场景', detail: '先看到伴星与当前交流' },
                { value: 'history', label: '聊天记录', detail: '按时间顺序浏览完整对话' },
              ]}
              onChange={(value) => setChatLayout(value, userId)}
            />
          </div>
        </div>

        <div className="reading-sample settings-sample">
          <span className="paper-corner" aria-hidden="true" />
          <small>试读一小段</small>
          <p style={{ fontSize: `calc(15px * var(--text-scale))` }}>
            先看一个例子，
            <br />
            再用自己的话解释。
          </p>
          <span className="sample-rule" aria-hidden="true" />
        </div>

        <ParticipationPreferences />
        <p className="group-label">动效</p>
        <label className="remember-setting glass">
          <span>
            <strong>减少动效</strong>
            <small id="motion-state">{motionSource}</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            aria-label="减少动效"
            aria-describedby="motion-state"
            checked={motion.off}
            disabled={motionLocked}
            onChange={(event) => setLocalMotionOff(event.target.checked)}
          />
        </label>

        <p className="utility-footnote">换一个书房，依然照你的习惯。</p>
      </div>
    </section>
  )
}

interface SettingChoiceOption<T extends string | number> {
  value: T
  label: string
  detail?: string
}

function SettingChoice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: SettingChoiceOption<T>[]
  onChange: (value: T) => void
}) {
  const root = usePhoneRoot()
  const sheet = useSheet()
  const open = sheet?.kind === 'setting-choice' && sheet.title === `选择${label}`
  const selected = options.find((option) => option.value === value)

  const showOptions = (event: MouseEvent<HTMLButtonElement>) => {
    const trigger = event.currentTarget
    if (open) {
      requestSheetClose()
      return
    }
    openSheet({
      kind: 'setting-choice',
      title: `选择${label}`,
      variant: 'glass',
      origin: originOf(trigger, root),
      trigger,
      children: <SettingChoiceOptions label={label} options={options} value={value} onChoose={onChange} />,
    })
  }

  return (
    <button
      className="setting-choice-trigger"
      type="button"
      aria-label={`${label}：${selected?.label ?? '未设置'}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={showOptions}
    >
      <span>{selected?.label ?? '未设置'}</span>
      <Icon name="chevron-down" />
    </button>
  )
}

function SettingChoiceOptions<T extends string | number>({
  label,
  options,
  value,
  onChoose,
}: {
  label: string
  options: SettingChoiceOption<T>[]
  value: T
  onChoose: (value: T) => void
}) {
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % options.length
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else return
    event.preventDefault()
    setActiveIndex(next)
    refs.current[next]?.focus({ preventScroll: true })
  }

  return (
    <div className="setting-choice-list" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={String(option.value)}
          ref={(node) => { refs.current[index] = node }}
          className="setting-choice-option"
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={activeIndex === index ? 0 : -1}
          data-selected={option.value === value ? 'true' : undefined}
          onFocus={() => setActiveIndex(index)}
          onKeyDown={(event) => onKeyDown(event, index)}
          onClick={() => {
            onChoose(option.value)
            requestSheetClose()
          }}
        >
          <span>
            <strong>{option.label}</strong>
            {option.detail && <small>{option.detail}</small>}
          </span>
          {option.value === value && <Icon name="check" />}
        </button>
      ))}
    </div>
  )
}
