import { describe, expect, it } from 'vitest'
import { layoutMindMap } from '@astella/shared/note-mind-map-layout'
import type { MindMapContentV1, MindMapNodeV1 } from '@astella/shared/note-mind-map-contracts'

function node(id: string, parentId: string | null, kind: MindMapNodeV1['kind'], label: string): MindMapNodeV1 {
  return { id, parentId, kind, label, explanation: null, references: [] }
}

const map: MindMapContentV1 = {
  schemaVersion: 1,
  rootId: 'r',
  nodes: [
    node('r', null, 'root', '复利的三个前提'),
    node('a', 'r', 'group', '本金'),
    node('b', 'r', 'group', '收益率'),
    node('c', 'r', 'group', '时间'),
    node('a1', 'a', 'concept', '不变'),
    node('b1', 'b', 'concept', '可测'),
  ],
}

/**
 * 这一份布局函数从桌面端挪到了公共层（2026-10-12），两端读同一篇脑图必须落在同一坐标。
 * 所以这里钉的不是"好不好看"，而是**同一输入给同一输出**这条可复用的前提。
 */
describe('脑图布局', () => {
  it('每个节点都有一个位置，主题在原点', () => {
    const { positions } = layoutMindMap(map, new Set())
    expect(positions).toHaveLength(map.nodes.length)
    const root = positions.find((item) => item.node.id === 'r')!
    expect(root.x).toBe(0)
    expect(root.y).toBe(0)
    expect(root.width).toBe(196)
    expect(positions.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true)
  })

  it('一级分支摊到两侧', () => {
    const { positions } = layoutMindMap(map, new Set())
    const sides = positions.filter((item) => item.node.parentId === 'r').map((item) => item.side)
    expect(sides).toContain(-1)
    expect(sides).toContain(1)
  })

  it('收起一支之后，那一支的子孙都不再占位置', () => {
    const open = layoutMindMap(map, new Set())
    const collapsed = layoutMindMap(map, new Set(['a']))
    expect(collapsed.positions.filter((item) => item.node.parentId === 'a')).toHaveLength(0)
    expect(collapsed.positions.length).toBe(open.positions.length - 1)
  })

  it('同一份内容两次布局结果逐点相同（两端同图的底）', () => {
    const first = layoutMindMap(map, new Set())
    const again = layoutMindMap(map, new Set())
    expect(again.positions.map((item) => `${item.node.id}:${item.x},${item.y}`)).toEqual(
      first.positions.map((item) => `${item.node.id}:${item.x},${item.y}`),
    )
    expect(again.bounds).toEqual(first.bounds)
  })

  it('越深的层离中心越远，父子不同层不会叠在同一个 x 上', () => {
    const { positions } = layoutMindMap(map, new Set())
    const child = positions.find((item) => item.node.id === 'r')!
    const grand = positions.find((item) => item.node.id === 'a1')!
    expect(Math.abs(grand.x)).toBeGreaterThan(Math.abs(child.x))
  })
})
