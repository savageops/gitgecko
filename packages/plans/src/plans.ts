/**
 * @gitgecko/plans/plans — the PlanSpec tier model + the plan-enforcement gate.
 *
 * This is the public, dependency-light half of the billing surface. The
 * published CLI imports only this module (the plan gate runs client-side so
 * the cloud pathway can pre-check before sending a metered request). The
 * server-only billing concerns live in a separate private package.
 *
 * THE WEDGE (evidence-backed, UX-SYNTHESIS.md §1): every cloud-pathway review
 * passes through a plan gate that decides "does this user's plan permit this
 * action?" Both proprietary competitors have a 3-tier model:
 *  - CodeRabbit: a limited free tier (PR summarization + IDE/CLI reviews on
 *    public repos only) → Pro ($24) / Pro Plus ($48) / Enterprise.
 *  - Greptile: Free (50 credits/mo) / Pro ($30) / Enterprise (self-host+SSO).
 * GitGecko does it better: its free tier includes UNLIMITED *agentic* native-agent
 * reviews (the zero-cost path, A13 — the developer's own installed agent is the
 * model, so it costs GitGecko nothing). Neither competitor offers free agentic
 * reviews: CR's free tier is summarization-only; GP's free tier meters every
 * review against 50 credits. Only GitGecko's cloud-pathway reviews (where GitGecko pays
 * for the LLM) consume metered credits. This is the "generous free plan"
 * mandate made concrete + auditable.
 *
 * Cap ladder (coined rule — not thumb-sucked): free=50, pro=500 (10× step),
 * max=2000 (4× step — tuned to recoverable cloud-LLM cost per seat). The IF/WHY:
 * the ladder gives a clear upgrade incentive at each step without a cliff.
 *
 * Provenance (G11): tier prices from the UX-RE harvest
 * (.docs/todo/research/re-coderabbit/_web-ux/pricing.md,
 *  .docs/todo/research/re-greptile/_web-ux/pricing.md). The free-tier-native-
 * unlimited wedge is GitGecko-original (A13 = goal §1.1 zero-config native-agent
 * execution; W2 = self-hostable; OQ6.5 = the better-auth/SSO spike).
 */

/** The canonical plan tiers. Stable IDs — used in the DB, the UI, and the gate. */
export type PlanId = "free" | "pro" | "max" | "enterprise";

/**
 * A plan tier. Defines what a user on this plan may do + at what price.
 * Higher tiers are supersets of lower ones (the precedence is free < pro < max
 * < enterprise).
 */
export interface PlanSpec {
  readonly id: PlanId;
  /** Human-readable name (for the pricing UI). */
  readonly name: string;
  /** Price per seat per month in USD, or null for custom/enterprise ("contact sales"). */
  readonly priceUsdPerSeat: number | null;
  /**
   * Native-agent reviews per month (A13 — the zero-cost path). Infinity on
   * EVERY plan: native-agent reviews cost GitGecko nothing (the developer's own
   * installed agent is the model), so they are never metered. This is the
   * concrete expression of the "generous free plan" mandate.
   */
  readonly nativeAgentReviews: number;
  /**
   * Cloud-pathway credits per month (the metered surface). A cloud review
   * consumes credits because GitGecko pays for the LLM. undefined = unlimited
   * (enterprise/custom). The free tier has a real, finite cap.
   */
  readonly cloudCreditsPerMonth: number | undefined;
  /** Whether this tier permits self-hosting (W2). Enterprise only. */
  readonly selfHost: boolean;
  /**
   * Whether this tier currently exposes a verified SSO/SAML capability.
   * Keep false until the better-auth SSO plug and IdP spike are executable;
   * entitlement copy must never outrun the shipped auth owner.
   */
  readonly sso: boolean;
  /** The precedence rank (free < pro < max < enterprise). Audit trail. */
  readonly rank: number;
}

/** The actions the plan gate can evaluate. */
export type PlanAction =
  | "native-review" // a review run via a detected native agent (zero-cost path)
  | "cloud-review" // a review run via the cloud/BYOK pathway (metered)
  | "model-inference" // direct use of an gitgecko-hosted model endpoint (metered)
  | "self-host"; // deploying the platform self-hosted (enterprise only)

/** The user's current usage state (for metering checks). */
export interface UsageState {
  /** Cloud credits consumed this billing month. */
  readonly cloudCreditsUsedThisMonth: number;
  /** Native-agent reviews this month (tracked for analytics; never gated). */
  readonly nativeAgentReviewsUsedThisMonth: number;
}

/** The enforcement decision. */
export interface EnforceResult {
  readonly allowed: boolean;
  /** Present only when blocked — the actionable reason + the upgrade path. */
  readonly reason?: string;
  /** The plan that was evaluated (for logging / the trace). */
  readonly plan: PlanId;
}

/**
 * The canonical plan catalog — the single source of truth for tier definitions.
 * Evidence: UX-SYNTHESIS.md §1 (the competitor pricing harvest).
 */
export const CANONICAL_PLANS: readonly PlanSpec[] = [
  {
    id: "free",
    name: "Free",
    priceUsdPerSeat: 0,
    nativeAgentReviews: Infinity, // the A13 wedge — unlimited, unmetered
    cloudCreditsPerMonth: 50, // matches Greptile's free-tier credit allowance
    selfHost: false,
    sso: false,
    rank: 0,
  },
  {
    id: "pro",
    name: "Pro",
    priceUsdPerSeat: 24, // matches CodeRabbit Pro
    nativeAgentReviews: Infinity,
    cloudCreditsPerMonth: 500, // generous above free; metered cloud cost
    selfHost: false,
    sso: false,
    rank: 1,
  },
  {
    id: "max",
    name: "Max",
    priceUsdPerSeat: 48, // matches CodeRabbit Pro Plus
    nativeAgentReviews: Infinity,
    cloudCreditsPerMonth: 2000, // higher cap for power users / teams
    selfHost: false,
    sso: false,
    rank: 2,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceUsdPerSeat: null, // custom — "contact sales"
    nativeAgentReviews: Infinity,
    cloudCreditsPerMonth: undefined, // unlimited (custom invoicing)
    selfHost: true, // W2 — self-host is the enterprise wedge
    // Reserved enterprise entitlement; the OQ6.5 SAML spike and @better-auth/sso
    // plug are not shipped yet, so marketing must not advertise this capability.
    sso: false,
    rank: 3,
  },
];

/** Look up a plan by id. Returns undefined for an unknown id (caller decides). */
export const getPlan = (id: PlanId): PlanSpec | undefined =>
  CANONICAL_PLANS.find((p) => p.id === id);

/**
 * The plan-enforcement gate. Decides whether a given action is permitted under
 * the user's plan + current usage. THE GATE every cloud-pathway review passes
 * through. Pure function (no I/O) — the caller passes the usage state.
 *
 * The why: without this gate, "free with a usage cap" is just words. The gate
 * makes the cap real, auditable, and actionable (it names the upgrade path).
 *
 * TOCTOU boundary (named honestly): this is an ADVISORY PRE-CHECK, not an
 * atomic reservation. It reads `usage` but does not reserve or increment — the
 * caller MUST atomically increment-and-bound (CAS or a lock) when committing a
 * cloud review, else two concurrent reviews can both read 49/50 and both run
 * (51/50). The gate gives the policy decision; the caller owns the atomic commit.
 *
 * @param planId - the user's plan tier.
 * @param request - the action being requested.
 * @param usage - the user's current usage state (for metering).
 */
export const enforcePlan = (
  planId: PlanId,
  request: { action: PlanAction },
  usage: UsageState,
): EnforceResult => {
  const plan = getPlan(planId);
  if (!plan) {
    return { allowed: false, reason: `Unknown plan "${planId}". Contact support.`, plan: planId };
  }
  // L3 fix: dev-mode assert — nativeAgentReviews must be Infinity on every plan.
  // If a future edit sets it finite, the native-review branch would silently
  // allow unlimited reviews even with a finite cap. This assert makes that loud.
  if (plan.nativeAgentReviews !== Infinity) {
    throw new Error(`Plan "${planId}" has nativeAgentReviews=${plan.nativeAgentReviews} — must be Infinity (A13).`);
  }

  // Guard against NaN/negative usage counts — a billing leak waiting to happen.
  const creditsUsed = Number.isFinite(usage.cloudCreditsUsedThisMonth) && usage.cloudCreditsUsedThisMonth >= 0
    ? usage.cloudCreditsUsedThisMonth
    : 0;

  const { action } = request;

  // Native-agent reviews: ALWAYS allowed on every plan. Do NOT add a cap check
  // here — plan.nativeAgentReviews === Infinity by construction (A13), and the
  // field exists for analytics/UI only, NOT for gating. The mechanism: native
  // reviews cost GitGecko nothing (the developer's own installed agent is the model),
  // so they are structurally un-meterable. This branch is the free-tier wedge.
  if (action === "native-review") {
    return { allowed: true, plan: planId };
  }

  // Self-host: enterprise only (the W2 wedge).
  if (action === "self-host") {
    if (plan.selfHost) return { allowed: true, plan: planId };
    return {
      allowed: false,
      reason: `Self-hosting requires the Enterprise plan. Your current plan (${plan.name}) is cloud-only. Upgrade at gitgecko.com/settings/billing.`,
      plan: planId,
    };
  }

  // Cloud review: metered. Check the credit cap.
  if (action === "cloud-review" || action === "model-inference") {
    if (plan.cloudCreditsPerMonth === undefined) {
      // Unlimited (enterprise/custom).
      return { allowed: true, plan: planId };
    }
    if (creditsUsed >= plan.cloudCreditsPerMonth) {
      return {
        allowed: false,
        reason:
          `Cloud-credit cap reached (${creditsUsed}/${plan.cloudCreditsPerMonth} this month) on the ${plan.name} plan. ` +
          `Native-agent reviews remain unlimited (zero-cost). To keep using cloud reviews, upgrade at gitgecko.com/settings/billing.`,
        plan: planId,
      };
    }
    return { allowed: true, plan: planId };
  }

  // Unknown action: deny explicitly. The gate never silently allows — a denied
  // unknown action is correct; a silently-allowed one is a billing leak.
  return {
    allowed: false,
    reason: `Unknown action "${action}". The plan gate does not recognize it — deny by default.`,
    plan: planId,
  };
};
