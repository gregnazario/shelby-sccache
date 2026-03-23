import { describe, it, expect } from "bun:test";
import { CircuitBreaker } from "../../src/shelby/circuit-breaker";

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker(0.5, 5000, 60000);
    expect(cb.state).toBe("closed");
    expect(cb.isOpen).toBe(false);
  });

  it("opens when error rate exceeds threshold", () => {
    const cb = new CircuitBreaker(0.5, 100, 60000); // 100ms window for testing
    cb.recordSuccess();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isOpen).toBe(true);
  });

  it("does not open when error rate is below threshold", () => {
    const cb = new CircuitBreaker(0.5, 100, 60000);
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordSuccess();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
  });

  it("transitions to half-open after recovery timeout", async () => {
    const cb = new CircuitBreaker(0.5, 100, 50); // 50ms recovery
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.state).toBe("half-open");
  });

  it("closes from half-open on success", async () => {
    const cb = new CircuitBreaker(0.5, 100, 50);
    cb.recordFailure();
    cb.recordFailure();
    await new Promise((r) => setTimeout(r, 60));
    expect(cb.state).toBe("half-open");
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
  });
});
