import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { Icon } from '../app/icons.tsx'
import { push } from '../app/nav.ts'
import { useSession } from '../state/session.ts'
import { handleUnauthorized } from '../state/session.ts'
import { loadMoreNotes, loadNotes, setNoteSearchQuery, updateNoteSearch, useNotes } from '../state/notes.ts'
import { ApiError } from '../platform/api-client.ts'
import { notesApi, type NoteListItem } from '../platform/api.ts'
import { MobileImage } from '../ui/MobileImage.tsx'
import { renderBlock } from './reading.ts'

/** 列表查询与返回后的结果保存在书架状态中，阅读回来仍是刚才那一页。 */

export function NotesPage() {
  const notes = useNotes()
  const session = useSession()
  const scroller = useRef<HTMLElement>(null)
  const searchRequest = useRef<AbortController | null>(null)
  const searchGeneration = useRef(0)
  const query = notes.browse.query
  const search = notes.browse.search
  const keyword = query.trim()

  useEffect(() => {
    void loadNotes(true)
  }, [])

  const runSearch = useCallback(async ({
    q,
    cursor,
    append,
    generation,
  }: {
    q: string
    cursor?: string
    append: boolean
    generation: number
  }) => {
    searchRequest.current?.abort()
    const controller = new AbortController()
    searchRequest.current = controller
    updateNoteSearch((current) => ({
      ...current,
      loading: append ? current.loading : true,
      loadingMore: append,
      error: null,
    }))
    try {
      const page = await notesApi.search({ q, limit: 20, cursor, signal: controller.signal })
      if (generation !== searchGeneration.current) return
      updateNoteSearch((current) => ({
        items: append ? [...current.items, ...page.items] : page.items,
        total: page.total,
        nextCursor: page.nextCursor,
        loading: false,
        loadingMore: false,
        error: null,
      }))
    } catch (error) {
      if (generation !== searchGeneration.current || controller.signal.aborted) return
      if (error instanceof ApiError && error.isUnauthorized) {
        handleUnauthorized()
        return
      }
      updateNoteSearch((current) => ({
        ...current,
        loading: false,
        loadingMore: false,
        error: searchMessage(error),
      }))
    } finally {
      if (searchRequest.current === controller) searchRequest.current = null
    }
  }, [])

  useEffect(() => {
    searchRequest.current?.abort()
    const generation = ++searchGeneration.current
    if (!keyword) {
      updateNoteSearch({ items: [], total: 0, nextCursor: null, loading: false, loadingMore: false, error: null })
      return
    }
    updateNoteSearch((current) => ({ ...current, loading: true, loadingMore: false, error: null }))
    const timer = window.setTimeout(() => {
      void runSearch({ q: keyword, append: false, generation })
    }, 260)
    return () => {
      window.clearTimeout(timer)
      searchRequest.current?.abort()
      if (searchGeneration.current === generation) searchGeneration.current += 1
    }
  }, [keyword, session.me?.workspaceId, runSearch])

  useEffect(() => () => {
    searchRequest.current?.abort()
    searchGeneration.current += 1
  }, [])

  const loadMoreSearch = useCallback(() => {
    if (!keyword || !search.nextCursor || search.loading || search.loadingMore) return
    void runSearch({
      q: keyword,
      cursor: search.nextCursor,
      append: true,
      generation: searchGeneration.current,
    })
  }, [keyword, runSearch, search.loading, search.loadingMore, search.nextCursor])

  function onScroll() {
    const node = scroller.current
    if (!node || node.scrollHeight - node.scrollTop - node.clientHeight >= 160) return
    if (keyword) loadMoreSearch()
    else void loadMoreNotes()
  }

  function retrySearch() {
    if (!keyword) return
    void runSearch({ q: keyword, append: false, generation: searchGeneration.current })
  }

  const searching = Boolean(keyword)
  const count = searching
    ? search.loading && search.items.length === 0 ? '正在搜索…' : `${search.total} 条结果`
    : notes.list.loading && notes.list.items.length === 0
      ? '正在加载…'
      : notes.list.nextCursor
        ? `已载入 ${notes.list.items.length} 篇`
        : `${notes.list.items.length} 篇笔记`

  return (
    <section className="page-scroll" ref={scroller} onScroll={onScroll} data-view-key="notes" aria-label="手记内容">
      <div className="section-title">
        <div>
          <h1>手记</h1>
          <p>已经留下的，随时回来读。</p>
        </div>
        <span>{count}</span>
      </div>

      <div className="search">
        <Icon name="search" aria-hidden="true" />
        <label className="visually-hidden" htmlFor="note-search">搜索手记标题与正文</label>
        <input
          id="note-search"
          value={query}
          placeholder="搜索标题与正文"
          onChange={(event) => setNoteSearchQuery(event.target.value)}
        />
        {query && (
          <button className="search-clear" type="button" aria-label="清除搜索" onClick={() => {
            setNoteSearchQuery('')
            requestAnimationFrame(() => document.getElementById('note-search')?.focus({ preventScroll: true }))
          }}>
            <Icon name="x" />
          </button>
        )}
      </div>

      <div className="list-label">
        <span>{session.me?.workspaceName ?? '我的书房'}</span>
        <span>{searching ? '标题与正文匹配' : '按最近更新'}</span>
      </div>

      {!searching && notes.list.error && (
        <div className="notes-load-error state-note" role="alert">
          <p>{notes.list.error}</p>
          <button type="button" disabled={notes.list.loading} onClick={() => void loadNotes(true)}>
            {notes.list.loading ? '正在重新加载…' : '重新加载手记'}
          </button>
        </div>
      )}

      {searching && search.items.map((item) => (
        <button
          key={item.objectId}
          className="note-row search-result"
          data-focus-key={`note:${item.objectId}`}
          type="button"
          onClick={() => push({ kind: 'reader', noteId: item.objectId, title: item.title ?? '' })}
        >
          <span className="book-cover"><Icon name="book-open" /></span>
          <span className="search-result-copy">
            <strong>{item.title || '无标题笔记'}</strong>
            <p>{item.snippet ? highlighted(item.snippet) : '标题中找到这个关键词。'}</p>
            <small>
              {item.matchCount ? `匹配 ${item.matchCount} 处` : '正文匹配'}
              {formatWhen(item.indexedAt) ? ` · 更新于 ${formatWhen(item.indexedAt)}` : ''}
            </small>
          </span>
          <Icon name="chevron-right" />
        </button>
      ))}

      {!searching && notes.list.items.map((item) => (
        <button key={item.id} className="note-row" data-focus-key={`note:${item.id}`} type="button" onClick={() => push({ kind: 'reader', noteId: item.id, title: item.title })}>
          <NoteCover item={item} />
          <span>
            <strong>{item.title}</strong>
            <small>更新于 {formatWhen(item.updatedAt)}</small>
          </span>
          <Icon name="chevron-right" />
        </button>
      ))}

      {searching && search.loading && search.items.length === 0 && <p className="empty" role="status">正在搜索标题和正文。</p>}
      {searching && search.error && (
        <div className="notes-load-error state-note" role="alert">
          <p>{search.error}</p>
          <button type="button" disabled={search.loading} onClick={retrySearch}>
            {search.loading ? '正在重试…' : '重试搜索'}
          </button>
        </div>
      )}
      {!searching && notes.list.loading && <p className="empty" role="status">正在取你的笔记。</p>}
      {searching && !search.loading && !search.error && search.items.length === 0 && (
        <div className="empty"><Icon name="search" /><p>没有找到匹配的手记，可以换个词试试。</p></div>
      )}
      {!searching && !notes.list.loading && !notes.list.error && notes.list.items.length === 0 && (
        <div className="empty"><Icon name="book-open" /><p>这里还没有内容。想留下时，告诉伴星整理成笔记。</p></div>
      )}
      {searching && search.loadingMore && <p className="empty" role="status">正在找更早的匹配内容。</p>}
      {!searching && notes.list.loadingMore && <p className="empty" role="status">更早的还在来。</p>}

      {searching && search.error && search.nextCursor && (
        <button className="load-more-notes secondary" type="button" disabled={search.loadingMore} onClick={loadMoreSearch}>
          重试加载更多结果
        </button>
      )}
      {searching && search.nextCursor && !search.error && (
        <button className="load-more-notes secondary" type="button" disabled={search.loadingMore} onClick={loadMoreSearch}>
          {search.loadingMore ? '正在加载更多结果…' : `继续查看结果（${search.items.length} / ${search.total}）`}
        </button>
      )}
      {!searching && notes.list.nextCursor && (
        <button className="load-more-notes secondary" type="button" disabled={notes.list.loadingMore} onClick={() => void loadMoreNotes()}>
          {notes.list.loadingMore ? '正在加载更早的手记…' : '加载更早的手记'}
        </button>
      )}
    </section>
  )
}

function NoteCover({ item }: { item: NoteListItem }) {
  const image = item.firstImageBlock
    ? renderBlock({ ordinal: 0, type: 'image', content: item.firstImageBlock })
    : null
  if (image?.kind === 'image' && image.src) {
    const label = image.alt || `${item.title}中的配图`
    return (
      <span className={`book-cover has-photo${item.shareScope === 'shared' ? ' blue' : ''}`}>
        <span className="book-cover-photo">
          <MobileImage url={image.src} alt={label} label={label} compact />
        </span>
        <span className="book-cover-photo-label" aria-hidden="true"><Icon name="image" />配图</span>
      </span>
    )
  }
  return (
    <span className={`book-cover${item.shareScope === 'shared' ? ' blue' : ''}`}>
      <Icon name="book-open" />
    </span>
  )
}

function highlighted(value: string): ReactNode[] {
  return value.split(/(«[^»]*»)/g).filter(Boolean).map((part, index) => (
    part.startsWith('«') && part.endsWith('»')
      ? <mark key={index}>{part.slice(1, -1)}</mark>
      : <span key={index}>{part}</span>
  ))
}

function searchMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 0) return '网络暂时不可用，请检查连接后重试。'
    if (error.status >= 500) return '搜索服务暂时不可用，请稍后重试。'
    return error.message || '搜索没有完成，请重试。'
  }
  return error instanceof Error ? error.message : '搜索没有完成，请重试。'
}

function formatWhen(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const now = Date.now()
  const diff = now - date.getTime()
  if (diff < 90_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000 && date.getDate() === new Date(now).getDate()) {
    return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  return sameYear ? `${month} 月 ${day} 日` : `${date.getFullYear()} 年 ${month} 月 ${day} 日`
}
