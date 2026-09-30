/** Constructor inheritance used by CommonJS archive and stream dependencies. */
import { inherits as nodeInherits } from 'node:util'
import { expect, it } from 'vitest'
import { inherits } from '../../src/node/builtin_modules/implemented/util.ts'

it('preserves child methods and matches Node constructor metadata', () => {
  const observe = (inherit: typeof nodeInherits) => {
    class Parent { parent(): number { return 7 } }
    class Child { own(): number { return 42 } }
    inherit(Child, Parent)
    const child = new Child()
    const parent = Object.getOwnPropertyDescriptor(Child, 'super_')!
    return {
      parentInstance: child instanceof Parent,
      constructor: child.constructor === Child,
      own: child.own(),
      superConstructor: parent.value === Parent,
      writable: parent.writable,
      enumerable: parent.enumerable,
      configurable: parent.configurable,
    }
  }
  expect(observe(inherits)).toEqual(observe(nodeInherits))
})

it('rejects absent constructors', () => {
  expect(() => { inherits(undefined, Date) }).toThrow(TypeError)
  expect(() => { inherits(Date, null) }).toThrow(TypeError)
})
