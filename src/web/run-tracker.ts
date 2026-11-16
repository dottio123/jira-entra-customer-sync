/**
 * Tracks background runs started by web requests so shutdown can stop accepting new runs,
 * signal in-flight runs to stop at their next safe point, and wait for them to finish.
 */
export class RunTracker {
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopping = false;

  get isStopping(): boolean {
    return this.stopping;
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  /** Registers a background run. Its rejection is expected to be handled by the caller. */
  track<T>(run: Promise<T>): Promise<T> {
    this.inFlight.add(run);
    const forget = () => this.inFlight.delete(run);
    run.then(forget, forget);
    return run;
  }

  /** Stops accepting new runs; services observe this through their shouldStop callback. */
  beginShutdown(): void {
    this.stopping = true;
  }

  /** Resolves when every tracked run has settled, or after `timeoutMs`, whichever is first. */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = Promise.allSettled([...this.inFlight]).then(() => true as const);
    try {
      return await Promise.race([settled, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
