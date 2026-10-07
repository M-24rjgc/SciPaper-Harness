/** Locale-owned HTML implementation name and iframe status text. */
export const zh = {
  title: 'HTML',
  frame: 'HTML 文档预览',
  loading: '文档渲染中...',
  failed: '无法预览这份 HTML 文档',
  enableInteractive: '启用交互预览',
  disableInteractive: '关闭交互预览',
  interactiveNotice: '交互预览会运行文档脚本并允许访问网络，请只为可信文档启用',
} satisfies Record<string, string>

/** HTML renderer dictionary keys. */
export type HtmlPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'HTML',
  frame: 'HTML document preview',
  loading: 'Rendering document...',
  failed: 'This HTML document could not be previewed.',
  enableInteractive: 'Enable interactive preview',
  disableInteractive: 'Disable interactive preview',
  interactiveNotice: 'Interactive preview runs document scripts with network access. Enable it only for trusted documents.',
} satisfies Record<HtmlPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** HTML preview selection and status text. */
    documentHtml: HtmlPreviewKey
  }
}
