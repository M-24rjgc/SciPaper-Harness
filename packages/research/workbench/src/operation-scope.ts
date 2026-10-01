/** The lifetime that a plugin's in-flight work belongs to: disabling the plugin aborts the work and waits for it to settle. */

/** Operations tied to one plugin lifetime and to the caller's own cancellation. */
export class OperationScope {
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()

  /**
   * Create a scope that has not been closed.
   * @param closedReason - the message that work aborted by {@link OperationScope.close} sees as its abort reason.
   */
  constructor(private readonly closedReason: string) {}

  /**
   * Execute work within both the caller's and the plugin's lifetimes.
   * @param signal - caller cancellation.
   * @param work - the operation; it receives a signal that fires on either cancellation.
   * @returns the operation's result; it rejects when either signal is aborted before or after the work completes.
   */
  run<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.lifetime.signal])
    combined.throwIfAborted()
    const operation = Promise.resolve().then(async () => {
      combined.throwIfAborted()
      const result = await work(combined)
      combined.throwIfAborted()
      return result
    })
    this.operations.add(operation)
    void operation.then(() => { this.operations.delete(operation) }, () => { this.operations.delete(operation) })
    return operation
  }

  /** Abort the work in flight and wait until every operation has settled. Work started afterwards is refused. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error(this.closedReason))
    await Promise.allSettled([...this.operations])
  }
}
