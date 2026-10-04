/** Shared, fixed HTML conversion rules. */
import TurndownService from 'turndown'
declare const converter: {
  createHtmlConverter(constructor: typeof TurndownService, plugin: TurndownService.Plugin): {
    renderHtml(html: string, maxInputChars: number): { text: string; sourceTruncated: boolean }
  }
}
export = converter
