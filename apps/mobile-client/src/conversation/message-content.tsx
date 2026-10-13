import { createElement, useId, useMemo, useState, type ReactNode } from 'react'
import { noteLinkTarget, noteMarkdownTree, type NoteMarkdownNode } from '@astella/shared/note-markdown'
import { companionContentBlockV1Schema } from '@astella/shared/companion-conversation-contracts'
import { goTab, push } from '../app/nav.ts'
import { Icon } from '../app/icons.tsx'
import { MobileImage } from '../ui/MobileImage.tsx'
import type { CompanionMessage } from '../platform/api.ts'

/** 见面时只预览伴星的话；查阅原文与其他内容仍留在记录中。 */
export function dialogueText(blocks: CompanionMessage['blocks']): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n\n')
}

export function followupPrompts(blocks: CompanionMessage['blocks']): string[] {
  return blocks.flatMap((raw) => {
    const parsed = companionContentBlockV1Schema.safeParse(raw)
    return parsed.success && parsed.data.type === 'follow_up_suggestions' ? parsed.data.prompts : []
  })
}

const TEXT_TAGS = new Set(['p', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br'])

function readNode(node: NoteMarkdownNode, key: number): ReactNode {
  if (node.type === 'text') return node.value
  if (node.type !== 'element') return null
  const children = node.children.map(readNode)
  if (node.tagName === 'a') {
    const href = typeof node.properties.href === 'string' ? node.properties.href : ''
    const target = noteLinkTarget(href)
    if (target?.kind === 'id') {
      const title = titleFromNoteLink(nodeText(node.children))
      return <PaperLink key={key} title={title} onClick={() => push({ kind: 'reader', noteId: target.value, title: '' })} />
    }
    if (/^https:\/\//i.test(href)) return <a key={key} href={href} target="_blank" rel="noreferrer noopener">{children}</a>
    return <span key={key}>{children}</span>
  }
  if (!TEXT_TAGS.has(node.tagName)) return <span key={key}>{children}</span>
  return createElement(node.tagName, { key }, ...children)
}

function PaperLink({ title, eyebrow = '关联手记', icon = 'book-open', onClick }: {
  title: string
  eyebrow?: string
  icon?: 'book-open' | 'message-square-text' | 'folder'
  onClick: () => void
}) {
  return (
    <button type="button" className="paper-link" aria-label={`打开关联手记：${title}`} onClick={onClick}>
      <span className="paper-link-icon"><Icon name={icon} /></span>
      <span className="paper-link-copy">
        <small>{eyebrow}</small>
        <strong>{title}</strong>
      </span>
      <Icon name="chevron-right" />
    </button>
  )
}

function nodeText(nodes: readonly NoteMarkdownNode[]): string {
  return nodes.map((node) => node.type === 'text' ? node.value : node.type === 'element' ? nodeText(node.children) : '').join(' ')
}

export function DialogueMarkdown({ text }: { text: string }) {
  const tree = useMemo(() => noteMarkdownTree(text), [text])
  return <div className="dialogue-markdown">{tree.children.map(readNode)}</div>
}

export function FollowupSuggestions({ prompts, onSend, disabled = false }: {
  prompts: readonly string[]
  onSend: (prompt: string) => void
  disabled?: boolean
}) {
  if (prompts.length === 0) return null
  return (
    <section className="mobile-followups" role="group" aria-label="可以接着问">
      <span>可以接着问</span>
      <div>
        {prompts.map((prompt, index) => (
          <button key={`${prompt}:${index}`} type="button" disabled={disabled} onClick={() => onSend(prompt)}>
            {prompt}
          </button>
        ))}
      </div>
    </section>
  )
}

function DialogueDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const contentId = useId()
  return (
    <section className="dialogue-material" data-open={open ? 'true' : undefined}>
      <button
        className="dialogue-material-trigger"
        type="button"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{label}</span>
        <Icon name="chevron-down" />
      </button>
      <div id={contentId} className="dialogue-material-content" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

export function MessageContent({ blocks, followUpPrompts: persistedFollowups, onFollowup, showFollowups = true, followupsDisabled = false }: {
  blocks: CompanionMessage['blocks']
  followUpPrompts?: readonly string[]
  onFollowup?: (prompt: string) => void
  showFollowups?: boolean
  followupsDisabled?: boolean
}) {
  const prompts = persistedFollowups?.length ? [...persistedFollowups] : followupPrompts(blocks)
  return <>{blocks.map((raw, index) => {
    const parsed = companionContentBlockV1Schema.safeParse(raw)
    if (!parsed.success) return <p className="thread-note" key={index}>这项内容暂时无法展示。</p>
    const block = parsed.data
    switch (block.type) {
      case 'text': return <DialogueMarkdown key={index} text={block.text} />
      case 'quote': return <DialogueDisclosure key={index} label={`查阅的材料 · ${block.label}`}><p>{block.text}</p></DialogueDisclosure>
      case 'code': return <pre key={index} className="dialogue-code"><code>{block.code}</code></pre>
      case 'image': return <figure key={index} className="dialogue-image"><MobileImage url={block.url} alt={block.alt ?? block.label} label={block.label} /><figcaption>{block.label}</figcaption></figure>
      case 'diagram': return <div className="dialogue-steps" key={index}><strong>{block.title}</strong><ol>{block.steps.map((step, stepIndex) => <li key={stepIndex}>{step.label}{step.detail && <p>{step.detail}</p>}</li>)}</ol></div>
      case 'nav': {
        if (block.route.kind === 'note') {
          const noteId = block.route.noteId
          return <PaperLink key={index} title={titleFromNoteLink(block.label)} onClick={() => push({ kind: 'reader', noteId, title: '' })} />
        }
        const kind = block.route.kind
        const title = block.label.replace(/\s*[↗→]\s*$/, '').trim()
        return <button key={index} type="button" className="paper-link" aria-label={`打开：${title}`} onClick={() => {
          if (kind === 'note_library') goTab('notes')
          else if (kind === 'conversation') goTab('chat')
        }} disabled={!['note_library', 'conversation'].includes(kind)}>
          <span className="paper-link-icon"><Icon name={kind === 'conversation' ? 'message-square-text' : 'folder'} /></span>
          <span className="paper-link-copy"><small>打开入口</small><strong>{title}</strong></span>
          <Icon name="chevron-right" />
        </button>
      }
      case 'citation': return block.target.kind === 'external_https' ? <a key={index} className="dialogue-citation" href={block.target.href} target="_blank" rel="noreferrer noopener">{block.label} ↗</a> : <p key={index} className="thread-note">{block.label}</p>
      case 'card': return <DialogueDisclosure key={index} label={`学习卡${block.summary ? ` · ${block.summary}` : ''}`}><DialogueMarkdown text={block.front} /></DialogueDisclosure>
      case 'follow_up_suggestions': return null // Legacy rows are rendered once from the metadata-aware list below.
      case 'action_ref': return null // 真实提案继续由同一屏的 ProposalCard 处理。
    }
  })}{onFollowup && showFollowups
    ? <FollowupSuggestions prompts={prompts} onSend={onFollowup} disabled={followupsDisabled} />
    : null}</>
}

function titleFromNoteLink(label: string): string {
  const title = label.match(/[《「“]([^》」”]+)[》」”]/)?.[1]
  const cleaned = title ?? label
    .replace(/^\s*(?:(?:打开|查看|前往)\s*)?(?:关联\s*)?(?:手记|笔记)?\s*/, '')
    .replace(/\s*[↗→]\s*$/, '')
  return cleaned.replace(/\s+/g, ' ').trim() || '查看手记'
}
