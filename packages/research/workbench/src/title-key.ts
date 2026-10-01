/** Title matching shared by the knowledge plugins, kept apart so none of them has to load another to compare titles. */

/**
 * A title reduced to lowercase letters and digits, for deciding that two references are the same paper.
 * @param title - a paper's or reference's title.
 * @returns the title without case, accents, spacing or punctuation.
 */
export function titleKey(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}
