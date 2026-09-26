/** Promise-based streams share the worker's readable-stream implementation. */
import { promises } from './stream.ts'

/** Promise-based pipeline and single-stream completion helpers from the worker's shared stream implementation. */
export const { pipeline, finished } = promises
export default promises
