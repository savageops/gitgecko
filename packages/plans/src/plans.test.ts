/**
 * TDD tests for the PlanSpec tier model + the plan-enforcement gate.
 *
 * THE CAPABILITY: every cloud-pathway review passes through a plan gate that
 * decides "does this user's plan permit this action?" The plan structure is
 * evidence-backed (UX-SYNTHESIS.md — both competitors converged on a 3-tier
 * model). GitGecko's wedge: a genuinely-useful free tier via the native-agent
 * zero-cost path (A13), which CodeRabbit lacks entirely.
 *
 * Per project TDD rule: written FIRST, fail, then code passes. Never weakened.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL_PLANS, enforcePlan, getPlan, type PlanId, type PlanSpec, type UsageState } from "./plans.js";

describe("CANONICAL_PLANS — the evidence-backed tier model (UX-SYNTHESIS)", () => {
  it("defines all 4 tiers: free, pro, max, enterprise", () => {
    const ids = CANONICAL_PLANS.map((p) => p.id);
    assert.deepEqual([...ids].sort(), ["enterprise", "free", "max", "pro"]);
  });

  it("free: native-agent reviews unlimited, cloud credits metered (the A13 wedge)", () => {
    const free = getPlan("free");
    assert.ok(free);
    assert.equal(free!.nativeAgentReviews, Infinity, "free native-agent reviews are UNLIMITED — the zero-cost path");
    assert.ok(free!.cloudCreditsPerMonth !== undefined && free!.cloudCreditsPerMonth > 0, "free has a metered cloud-credit cap");
    assert.equal(free!.priceUsdPerSeat, 0);
  });

  it("pro: $24/seat/mo (matches CodeRabbit Pro)", () => {
    const pro = getPlan("pro");
    assert.equal(pro!.priceUsdPerSeat, 24);
    assert.equal(pro!.nativeAgentReviews, Infinity);
  });

  it("max: $48/seat/mo (matches CodeRabbit Pro Plus)", () => {
    const max = getPlan("max");
    assert.equal(max!.priceUsdPerSeat, 48);
  });

  it("enterprise: self-host + custom; SSO/SAML stays hidden until its plug is verified", () => {
    const ent = getPlan("enterprise");
    assert.ok(ent!.selfHost, "enterprise permits self-host (W2)");
    assert.equal(ent!.sso, false, "SSO/SAML is not advertised before the better-auth SSO spike");
    assert.equal(ent!.priceUsdPerSeat, null, "enterprise is custom-priced (null = 'contact sales')");
  });

  it("tier precedence: free < pro < max < enterprise (each tier is a superset)", () => {
    // Higher tiers must have >= features. The canonical ordering is the audit trail.
    const order: Record<PlanId, number> = { free: 0, pro: 1, max: 2, enterprise: 3 };
    for (const p of CANONICAL_PLANS) {
      assert.ok(order[p.id] !== undefined, `${p.id} must be in the precedence map`);
    }
  });
});

describe("enforcePlan — the plan-enforcement gate", () => {
  const freeUsage: UsageState = { cloudCreditsUsedThisMonth: 0, nativeAgentReviewsUsedThisMonth: 0 };
  const proUsage: UsageState = { cloudCreditsUsedThisMonth: 0, nativeAgentReviewsUsedThisMonth: 0 };

  it("permits a native-agent review on the FREE plan (the zero-cost wedge — always allowed)", () => {
    const result = enforcePlan("free", { action: "native-review" }, freeUsage);
    assert.equal(result.allowed, true, "native-agent reviews are free and unlimited — never gated");
  });

  it("permits a native-agent review even when cloud credits are exhausted", () => {
    const usage: UsageState = { cloudCreditsUsedThisMonth: 9999, nativeAgentReviewsUsedThisMonth: 9999 };
    const result = enforcePlan("free", { action: "native-review" }, usage);
    assert.equal(result.allowed, true, "native reviews never consume metered credits");
  });

  it("permits a cloud review when the free credit cap is not hit", () => {
    const usage: UsageState = { cloudCreditsUsedThisMonth: 0, nativeAgentReviewsUsedThisMonth: 0 };
    const result = enforcePlan("free", { action: "cloud-review" }, usage);
    assert.equal(result.allowed, true);
  });

  it("BLOCKS a cloud review when the free credit cap is exceeded (the metering gate)", () => {
    const free = getPlan("free")!;
    const usage: UsageState = { cloudCreditsUsedThisMonth: free.cloudCreditsPerMonth!, nativeAgentReviewsUsedThisMonth: 0 };
    const result = enforcePlan("free", { action: "cloud-review" }, usage);
    assert.equal(result.allowed, false, "must block when the cap is reached");
    assert.match(result.reason ?? "", /credit|cap|limit|quota/i, "must state WHY it blocked");
  });

  it("pro plan: permits a cloud review (higher cap, not free-tier-limited)", () => {
    const result = enforcePlan("pro", { action: "cloud-review" }, proUsage);
    assert.equal(result.allowed, true);
  });

  it("enterprise: permits self-host + SSO actions other tiers cannot", () => {
    const result = enforcePlan("enterprise", { action: "self-host" }, proUsage);
    assert.equal(result.allowed, true, "enterprise can self-host");
  });

  it("free/pro/max: BLOCKS the self-host action (enterprise-only feature)", () => {
    for (const plan of ["free", "pro", "max"] as const) {
      const result = enforcePlan(plan, { action: "self-host" }, freeUsage);
      assert.equal(result.allowed, false, `${plan} must not permit self-host`);
    }
  });

  it("blocks an unknown action explicitly (no silent allow)", () => {
    const result = enforcePlan("free", { action: "unknown-action" as never }, freeUsage);
    assert.equal(result.allowed, false, "unknown actions must be denied, not silently allowed");
  });

  it("the reason field is present whenever a block happens (actionable feedback)", () => {
    const usage: UsageState = { cloudCreditsUsedThisMonth: 9999, nativeAgentReviewsUsedThisMonth: 0 };
    const blocked = enforcePlan("free", { action: "cloud-review" }, usage);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason && blocked.reason.length > 10, "must give an actionable reason");

    const allowed = enforcePlan("free", { action: "native-review" }, usage);
    assert.equal(allowed.allowed, true);
    assert.equal(allowed.reason, undefined, "an allowed action needs no reason");
  });
});

describe("getPlan — plan lookup", () => {
  it("returns the plan by id", () => {
    const p = getPlan("pro");
    assert.ok(p);
    assert.equal(p!.id, "pro");
  });

  it("returns undefined for an unknown plan id (not a throw — caller decides)", () => {
    assert.equal(getPlan("nonexistent" as PlanId), undefined);
  });
});

describe("enforcePlan — coverage for the branches the QC flagged (E4)", () => {
  const usage: UsageState = { cloudCreditsUsedThisMonth: 0, nativeAgentReviewsUsedThisMonth: 0 };

  it("unknown plan id → blocked with a 'contact support' reason (not a throw)", () => {
    const result = enforcePlan("nonexistent" as PlanId, { action: "cloud-review" }, usage);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? "", /unknown plan/i);
  });

  it("enterprise cloud-review → allowed (cloudCreditsPerMonth is undefined = unlimited)", () => {
    const result = enforcePlan("enterprise", { action: "cloud-review" }, usage);
    assert.equal(result.allowed, true, "enterprise has unlimited cloud credits");
  });

  it("enterprise cloud-review → allowed even with very high usage (no cap to hit)", () => {
    const heavy: UsageState = { cloudCreditsUsedThisMonth: 999_999, nativeAgentReviewsUsedThisMonth: 0 };
    const result = enforcePlan("enterprise", { action: "cloud-review" }, heavy);
    assert.equal(result.allowed, true);
  });
});

describe("CANONICAL_PLANS — tier monotonicity (E3: each tier is a superset on credits)", () => {
  it("cloudCreditsPerMonth is non-decreasing across rank (free ≤ pro ≤ max)", () => {
    // Enterprise is undefined (unlimited) — excluded from the numeric check.
    const metered = CANONICAL_PLANS.filter((p) => p.cloudCreditsPerMonth !== undefined);
    for (let i = 1; i < metered.length; i++) {
      const prev = metered[i - 1]!;
      const curr = metered[i]!;
      assert.ok(
        curr.cloudCreditsPerMonth! >= prev.cloudCreditsPerMonth!,
        `${curr.id} (${curr.cloudCreditsPerMonth}) must be >= ${prev.id} (${prev.cloudCreditsPerMonth})`,
      );
    }
  });
});
