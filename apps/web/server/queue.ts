/** Runs jobs one at a time: workflows share one SQLite file and paper accounts. */
export class RunQueue {
  #tail: Promise<unknown> = Promise.resolve();
  running: string | null = null;
  pending = 0;
  readonly errors: Array<{ label: string; error: string; at: string }> = [];

  enqueue<T>(label: string, job: () => Promise<T>): Promise<T> {
    this.pending++;
    const run = async () => {
      this.pending--;
      this.running = label;
      try {
        return await job();
      } catch (e) {
        this.errors.push({ label, error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() });
        if (this.errors.length > 50) this.errors.shift();
        throw e;
      } finally {
        this.running = null;
      }
    };
    const p = this.#tail.then(run, run);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  /** Resolves when everything queued so far has finished. */
  async idle(): Promise<void> {
    while (this.pending > 0 || this.running) await this.#tail;
  }
}
