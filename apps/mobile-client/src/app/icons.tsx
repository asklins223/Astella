import type { ReactNode } from 'react'

/**
 * 图标集：形状逐条取自 demo 的 `notebook-icons.js` 与 `mobile-companion-layout.js`
 * 里的 `extras`，不另画第二套线条。
 */
type Node = [tag: string, attrs: Record<string, string>][]

const SETS: Record<string, Node> = {
  sparkles: [
    ['path', { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' }],
    ['path', { d: 'M20 2v4' }],
    ['path', { d: 'M22 4h-4' }],
    ['circle', { cx: '4', cy: '20', r: '2' }],
  ],
  'user-round': [
    ['circle', { cx: '12', cy: '8', r: '5' }],
    ['path', { d: 'M20 21a8 8 0 0 0-16 0' }],
  ],
  'settings-2': [
    ['path', { d: 'M14 17H5' }],
    ['path', { d: 'M19 7h-9' }],
    ['circle', { cx: '17', cy: '17', r: '3' }],
    ['circle', { cx: '7', cy: '7', r: '3' }],
  ],
  history: [
    ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
    ['path', { d: 'M3 3v5h5' }],
    ['path', { d: 'M12 7v5l4 2' }],
  ],
  'circle-help': [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  lightbulb: [
    ['path', { d: 'M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5' }],
    ['path', { d: 'M9 18h6' }],
    ['path', { d: 'M10 22h4' }],
  ],
  'list-tree': [
    ['path', { d: 'M8 5h13' }],
    ['path', { d: 'M13 12h8' }],
    ['path', { d: 'M13 19h8' }],
    ['path', { d: 'M3 10a2 2 0 0 0 2 2h3' }],
    ['path', { d: 'M3 5v12a2 2 0 0 0 2 2h3' }],
  ],
  'message-square-text': [
    ['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }],
    ['path', { d: 'M7 11h10' }],
    ['path', { d: 'M7 15h6' }],
    ['path', { d: 'M7 7h8' }],
  ],
  'book-open': [
    ['path', { d: 'M12 5v16' }],
    ['path', { d: 'M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z' }],
  ],
  folder: [['path', { d: 'M3 7h6l2-3h8a2 2 0 0 1 2 2v13H3V7Z' }]],
  x: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'arrow-left': [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  'arrow-right': [['path', { d: 'M5 12h14' }], ['path', { d: 'm12 5 7 7-7 7' }]],
  menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  search: [['circle', { cx: '10.5', cy: '10.5', r: '6.5' }], ['path', { d: 'm16 16 5 5' }]],
  mic: [
    ['rect', { x: '9', y: '2', width: '6', height: '12', rx: '3' }],
    ['path', { d: 'M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8' }],
  ],
  send: [['path', { d: 'm21 3-6.5 18-4-7.5L3 9.5 21 3ZM10.5 13.5 21 3' }]],
  play: [['path', { d: 'm8 5 11 7-11 7V5Z' }]],
  pause: [['path', { d: 'M9 5v14M15 5v14' }]],
  pencil: [['path', { d: 'm15 4 5 5M4 20l4-1L20 7a2.1 2.1 0 0 0-3-3L5 16l-1 4Z' }]],
  eye: [
    ['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z' }],
    ['circle', { cx: '12', cy: '12', r: '3' }],
  ],
  'eye-off': [['path', { d: 'm3 3 18 18M10.5 5.1A12 12 0 0 1 22 12a18 18 0 0 1-4 4.5M14 18.8C6.5 20 2 12 2 12a18 18 0 0 1 4-4.5M10 10a3 3 0 0 0 4 4' }]],
  headphone: [
    ['path', { d: 'M4 15v-3a8 8 0 0 1 16 0v3' }],
    ['rect', { x: '2', y: '14', width: '5', height: '7', rx: '2' }],
    ['rect', { x: '17', y: '14', width: '5', height: '7', rx: '2' }],
  ],
  image: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['circle', { cx: '9', cy: '10', r: '1.6' }],
    ['path', { d: 'm4 18 5-5 4 4 3-2 4 4' }],
  ],
  camera: [
    ['rect', { x: '3', y: '6', width: '18', height: '14', rx: '2' }],
    ['path', { d: 'M8 6l2-3h4l2 3' }],
    ['circle', { cx: '12', cy: '13', r: '4' }],
  ],
  monitor: [['rect', { x: '3', y: '4', width: '18', height: '12', rx: '2' }], ['path', { d: 'M9 20h6M12 16v4' }]],
  lock: [['rect', { x: '4', y: '10', width: '16', height: '11', rx: '3' }], ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }]],
  shield: [['path', { d: 'M12 3l7 3v6c0 4.2-3 7.4-7 9-4-1.6-7-4.8-7-9V6l7-3Z' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  download: [
    ['path', { d: 'M12 3v12m0 0 4-4m-4 4-4-4' }],
    ['path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }],
  ],
  'log-out': [['path', { d: 'M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M10 12h11m-4-4 4 4-4 4' }]],
  'file-text': [
    ['path', { d: 'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z' }],
    ['path', { d: 'M14 2v5a1 1 0 0 0 1 1h5' }],
    ['path', { d: 'M10 9H8' }],
    ['path', { d: 'M16 13H8' }],
    ['path', { d: 'M16 17H8' }],
  ],
  quote: [
    ['path', { d: 'M9 7H5a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v1a2 2 0 0 1-2 2' }],
    ['path', { d: 'M19 7h-4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3v1a2 2 0 0 1-2 2' }],
  ],
  wifi: [['path', { d: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01' }]],
  offline: [['path', { d: 'm3 3 18 18M2 8a16 16 0 0 1 5-3M13 4a16 16 0 0 1 9 4M5 12a11 11 0 0 1 5-2M8.5 16a5.5 5.5 0 0 1 7 0M12 20h.01' }]],
  signal: [['path', { d: 'M4 20v-3M9 20v-7M14 20V9M19 20V4' }]],
}

/** 尺寸一律由样式表决定（demo 就是这样的：`svg{width:20px}` 加各处选择器），代码里不写死。 */
export function Icon({ name }: { name: string }) {
  const nodes = SETS[name] ?? SETS['file-text']
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {nodes.map(([tag, attrs], index) => {
        const Tag = tag as 'path'
        return <Tag key={index} {...attrs} />
      })}
    </svg>
  )
}

export function iconNodes(name: string): ReactNode {
  return (SETS[name] ?? SETS['file-text']).map(([tag, attrs], index) => {
    const Tag = tag as 'path'
    return <Tag key={index} {...attrs} />
  })
}
