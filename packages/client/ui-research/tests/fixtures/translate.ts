/** A bound dictionary lookup over one language, for specs that render with the real wording. */
import type { Translate } from '../../src/client/format.ts'

/**
 * Look keys up in a dictionary and fill their `{name}` placeholders the way the slot framework does.
 * @param dictionary - one language of the research dictionary.
 * @returns the lookup; an unknown key throws, so a misspelt key fails the spec at once.
 */
export function translate(dictionary: Readonly<Record<string, string>>): Translate {
  return (key, params) => {
    const text = dictionary[key]
    if (text === undefined) throw new Error(`No such key: ${key}`)
    return text.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = params?.[name]
      return typeof value === 'string' || typeof value === 'number' ? String(value) : match
    })
  }
}
