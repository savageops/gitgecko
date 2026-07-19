/**
 * @gitgecko/plans — the public plan-tier model + the plan-enforcement gate.
 *
 * Single export surface for the published CLI. The cloud pathway calls
 * `enforcePlan(planId, { action }, usage)` before sending a metered request,
 * so the gate runs client-side. Everything here is pure and has no
 * `@gitgecko/*` dependencies.
 *
 * See `./plans.ts` for the tier catalog and the gate's policy.
 */
export {
  CANONICAL_PLANS,
  enforcePlan,
  getPlan,
  type PlanId,
  type PlanSpec,
  type PlanAction,
  type UsageState,
  type EnforceResult,
} from "./plans.js";
