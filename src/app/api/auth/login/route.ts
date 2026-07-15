import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
  createSessionToken,
  verifyPassword,
} from "@/lib/auth";
import { createRateLimiter, getClientIp, getLoginRateLimitKey } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Primary per-client limiter: keyed on the (rightmost XFF hop, CF-Connecting-IP)
// tuple via `getLoginRateLimitKey`, not the rightmost XFF hop alone. This
// deployment (usage.jays.services) is always fronted by Cloudflare in front
// of Render, so the rightmost XFF hop Render observes is Cloudflare's own
// egress IP - shared by every Cloudflare-proxied client, not a per-visitor
// address. CF-Connecting-IP is set by Cloudflare itself from the
// TLS-terminated connection and can't be forged by a client going through
// Cloudflare, so pairing it with the shared egress hop separates distinct
// CF-proxied clients back out again. See `getLoginRateLimitKey` in
// rate-limit.ts for the full rationale, including why this stays safe for
// traffic that reaches Render directly.
const loginRateLimiterByTuple = createRateLimiter(60_000, 5);

// Backstop keyed on the rightmost XFF hop alone (via `getClientIp`, with no
// CF-Connecting-IP component) - NOT an IP-independent global bucket. A
// single source can fragment its own tuple key into many buckets by forging
// and rotating CF-Connecting-IP (see rate-limit.ts), so this backstop
// re-aggregates by the one hop that source cannot spoof, capping its total
// attempts regardless of how many tuple keys it produced. Keeping the
// backstop per rightmost-hop rather than one shared global bucket also means
// a single abusive source - including a burst of distinct CF-proxied
// clients hammering through the same shared Cloudflare egress IP - cannot
// exhaust one pool and deny login to every other client, including the
// legitimate owner. Same ~20/min budget the old global backstop used.
const loginBackstopByRightmostHop = createRateLimiter(60_000, 20);

export async function POST(request: NextRequest) {
  if (!process.env.DASHBOARD_PASSWORD?.trim()) {
    return NextResponse.json(
      { error: "Dashboard auth is not configured" },
      { status: 503 }
    );
  }

  const tupleKey = getLoginRateLimitKey(request);
  const rightmostHop = getClientIp(request);

  // Only check whether budget is available - do NOT consume yet. Consuming
  // happens later, only for attempts that turn out to be failed logins, so a
  // legitimate successful login never eats into the attacker-facing budget.
  const withinTupleLimit = loginRateLimiterByTuple.isAllowed(tupleKey);
  const withinBackstop = loginBackstopByRightmostHop.isAllowed(rightmostHop);
  if (!withinTupleLimit || !withinBackstop) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  let password: unknown;
  try {
    const body = await request.json();
    password = body?.password;
  } catch {
    loginRateLimiterByTuple.recordAttempt(tupleKey);
    loginBackstopByRightmostHop.recordAttempt(rightmostHop);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  if (typeof password !== "string" || !password || !verifyPassword(password)) {
    // Failed authentication: record the attempt against both budgets.
    loginRateLimiterByTuple.recordAttempt(tupleKey);
    loginBackstopByRightmostHop.recordAttempt(rightmostHop);
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // Successful login: intentionally does not call recordAttempt on either
  // limiter, so the legitimate owner logging in repeatedly never exhausts
  // their own budget.
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
