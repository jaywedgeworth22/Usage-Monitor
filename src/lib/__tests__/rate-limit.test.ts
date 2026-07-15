import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRateLimiter, getClientIp, getLoginRateLimitKey } from "../rate-limit";

describe("createRateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxRequests per key within the window, then blocks", () => {
    const limiter = createRateLimiter(60_000, 3);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("a")).toBe(false);
  });

  it("tracks separate keys independently", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("b")).toBe(true);
    expect(limiter.check("a")).toBe(false);
    expect(limiter.check("b")).toBe(false);
  });

  it("resets a key's count once its window elapses", () => {
    const limiter = createRateLimiter(60_000, 1);
    expect(limiter.check("a")).toBe(true);
    expect(limiter.check("a")).toBe(false);

    vi.advanceTimersByTime(60_000);

    expect(limiter.check("a")).toBe(true);
  });

  describe("isAllowed / recordAttempt", () => {
    it("isAllowed never consumes budget, no matter how many times it's called", () => {
      const limiter = createRateLimiter(60_000, 2);
      expect(limiter.isAllowed("a")).toBe(true);
      expect(limiter.isAllowed("a")).toBe(true);
      expect(limiter.isAllowed("a")).toBe(true);
      expect(limiter.isAllowed("a")).toBe(true);
      // Still fully available after repeated checks - only recordAttempt
      // consumes budget, confirmed by draining it explicitly here.
      limiter.recordAttempt("a");
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);
    });

    it("recordAttempt consumes budget even without a prior isAllowed call", () => {
      const limiter = createRateLimiter(60_000, 2);
      limiter.recordAttempt("a");
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);
    });

    it("isAllowed reflects budget already consumed by recordAttempt", () => {
      const limiter = createRateLimiter(60_000, 1);
      expect(limiter.isAllowed("a")).toBe(true);
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);
    });

    it("recordAttempt respects window expiry like check does", () => {
      const limiter = createRateLimiter(60_000, 1);
      limiter.recordAttempt("a");
      expect(limiter.isAllowed("a")).toBe(false);

      vi.advanceTimersByTime(60_000);

      expect(limiter.isAllowed("a")).toBe(true);
    });
  });
});

describe("getClientIp", () => {
  it("trusts only the rightmost X-Forwarded-For hop", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    });
    // The rightmost entry is the peer address our own proxy observed; the
    // leftmost is client-supplied and must not be trusted for rate limiting.
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("is not fooled by an attacker padding extra spoofed hops onto the header", () => {
    const spoofed = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9, 10.0.0.1",
      },
    });
    const direct = new Request("https://example.com", {
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    // Rotating every hop except the trusted one must resolve to the same key
    // as the trusted hop alone - otherwise an attacker can bypass a per-IP
    // limiter simply by varying the untrusted, client-controlled prefix.
    expect(getClientIp(spoofed)).toBe(getClientIp(direct));
  });

  it("trims whitespace around the trusted hop", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "1.2.3.4 ,  10.0.0.1  " },
    });
    expect(getClientIp(request)).toBe("10.0.0.1");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("https://example.com", {
      headers: { "x-real-ip": "198.51.100.7" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });

  it("falls back to 127.0.0.1 when no proxy headers are present", () => {
    const request = new Request("https://example.com");
    expect(getClientIp(request)).toBe("127.0.0.1");
  });

  it("ignores a blank x-forwarded-for value and falls back", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "  ", "x-real-ip": "198.51.100.7" },
    });
    expect(getClientIp(request)).toBe("198.51.100.7");
  });
});

describe("getLoginRateLimitKey", () => {
  it("gives two Cloudflare-proxied clients sharing the same egress IP distinct keys", () => {
    // usage.jays.services is fronted by Cloudflare -> Render, so the
    // rightmost XFF hop is Cloudflare's shared egress IP - identical for
    // every CF-proxied client - while CF-Connecting-IP (CF-set, untrustworthy
    // only outside the CF path) still tells them apart.
    const clientA = new Request("https://usage.jays.services/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "cf-connecting-ip": "198.51.100.11",
      },
    });
    const clientB = new Request("https://usage.jays.services/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "cf-connecting-ip": "198.51.100.22",
      },
    });
    expect(getClientIp(clientA)).toBe(getClientIp(clientB));
    expect(getLoginRateLimitKey(clientA)).not.toBe(getLoginRateLimitKey(clientB));
  });

  it("is stable for the same client across repeated requests", () => {
    const makeRequest = () =>
      new Request("https://usage.jays.services/api/auth/login", {
        headers: {
          "x-forwarded-for": "203.0.113.50",
          "cf-connecting-ip": "198.51.100.11",
        },
      });
    expect(getLoginRateLimitKey(makeRequest())).toBe(getLoginRateLimitKey(makeRequest()));
  });

  it("uses an empty cf-connecting-ip component when the header is absent", () => {
    const withoutCf = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.50" },
    });
    const withEmptyCf = new Request("https://usage.jays.services/api/auth/login", {
      headers: { "x-forwarded-for": "203.0.113.50", "cf-connecting-ip": "" },
    });
    // Both "absent" and "explicitly empty" resolve to the same "" component,
    // matching the documented "'' when absent" semantics.
    expect(getLoginRateLimitKey(withoutCf)).toBe(getLoginRateLimitKey(withEmptyCf));
    expect(getLoginRateLimitKey(withoutCf)).toContain("cf-connecting-ip=");
  });

  it("differs from getClientIp alone, so a shared egress IP doesn't collapse distinct tuples", () => {
    const request = new Request("https://usage.jays.services/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.50",
        "cf-connecting-ip": "198.51.100.11",
      },
    });
    expect(getLoginRateLimitKey(request)).not.toBe(getClientIp(request));
  });
});
