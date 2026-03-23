import { describe, it, expect } from "bun:test";
import { CircuitBreaker } from "../../src/shelby/circuit-breaker";

describe("ShelbyClient (unit — circuit breaker integration)", () => {
  it("circuit breaker prevents calls when open", () => {
    const cb = new CircuitBreaker(0.5, 100, 60000);
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.isOpen).toBe(true);
  });
});
// Full integration tests with real Shelby will be in test/integration/
