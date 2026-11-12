/**
 * In-memory fixed-window limiter (E11-F02) for login attempts and upload starts. One API process today
 * (ARCHITECTURE §13); with several replicas this moves to Redis (D-035).
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastSweep = 0;

  constructor(private readonly o: { limit: number; windowMs: number; now?: () => number }) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.o.windowMs) return;
    this.lastSweep = now;
    for (const [k, w] of this.windows) if (now - w.start >= this.o.windowMs) this.windows.delete(k);
  }

  /** Counts a hit; false = over the limit for this window. */
  hit(key: string): boolean {
    const now = this.now();
    this.sweep(now);
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.o.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.o.limit;
  }

  retryAfterSeconds(key: string): number {
    const w = this.windows.get(key);
    if (!w) return 0;
    return Math.max(0, Math.ceil((w.start + this.o.windowMs - this.now()) / 1000));
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  get size(): number {
    return this.windows.size;
  }
}
