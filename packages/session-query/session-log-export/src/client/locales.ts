/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'header.more': '更多操作',
  'menu.download': '下载 Session 日志',
  'menu.feedback': '反馈',
  'menu.logId': '日志 ID：{id}',
  'log.group': '会话日志',
  'log.label': '日志 ID',
  'log.fullId': '完整日志 ID：{id}',
  'log.copy': '复制日志 ID',
  'log.copied': '日志 ID 已复制',
  'log.copyFailed': '无法复制日志 ID',
  'log.export': '导出日志',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.successTitle': 'Session 导出已开始下载',
  'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'header.more': 'More actions',
  'menu.download': 'Download session log',
  'menu.feedback': 'Feedback',
  'menu.logId': 'Log ID: {id}',
  'log.group': 'Session log',
  'log.label': 'Log ID',
  'log.fullId': 'Full log ID: {id}',
  'log.copy': 'Copy log ID',
  'log.copied': 'Log ID copied',
  'log.copyFailed': 'Could not copy the log ID',
  'log.export': 'Export log',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
