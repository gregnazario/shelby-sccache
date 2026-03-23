export class CircuitBreaker {
  private errorThreshold: number;
  private windowMs: number;
  private recoveryMs: number;
  private successes: number[] = [];
  private failures: number[] = [];
  private _state: "closed" | "open" | "half-open" = "closed";
  private openedAt = 0;

  constructor(errorThreshold: number, windowMs: number, recoveryMs: number) {
    this.errorThreshold = errorThreshold;
    this.windowMs = windowMs;
    this.recoveryMs = recoveryMs;
  }

  get state(): "closed" | "open" | "half-open" {
    if (this._state === "open" && Date.now() - this.openedAt > this.recoveryMs) {
      this._state = "half-open";
    }
    return this._state;
  }

  get isOpen(): boolean {
    return this.state === "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      this._state = "closed";
      this.successes = [];
      this.failures = [];
      return;
    }
    this.successes.push(Date.now());
    this.prune();
  }

  recordFailure(): void {
    this.failures.push(Date.now());
    this.prune();
    this.checkThreshold();
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.successes = this.successes.filter((t) => t > cutoff);
    this.failures = this.failures.filter((t) => t > cutoff);
  }

  private checkThreshold(): void {
    const total = this.successes.length + this.failures.length;
    if (total < 2) return; // need minimum sample
    if (this.failures.length / total > this.errorThreshold) {
      this._state = "open";
      this.openedAt = Date.now();
    }
  }
}
