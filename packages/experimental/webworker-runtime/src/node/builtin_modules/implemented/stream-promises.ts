/** Promise-based streams share the worker's readable-stream implementation. */
import { promises } from './stream.ts'

export const { pipeline, finished } = promises
export default promises
