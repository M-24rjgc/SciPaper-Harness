/** `sidebar` namespace dictionaries for shell controls and global panels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新研究',
  'session.new.label': '新研究',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'panels.label': '全局面板',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New research',
  'session.new.label': 'New research',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'panels.label': 'Global panels',
} satisfies Record<SidebarKey, string>
