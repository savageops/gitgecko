/**
 * Browser-safe deployment configuration primitives.
 *
 * Deployment mode is a cross-plane contract. Keeping its normalization here
 * prevents the orchestrator, web auth, and gateways from drifting on blank
 * dotenv values or on which durable control database implies cloud mode.
 */
export type DeploymentMode = "local" | "cloud";

export type DeploymentOperator = "gitgecko" | "customer";

export type DeploymentProfileId = "standalone" | "managed-cloud" | "private-cloud";

export interface DeploymentProfile {
  readonly id: DeploymentProfileId;
  readonly mode: DeploymentMode;
  readonly operator: DeploymentOperator;
  readonly requiresAuthentication: boolean;
  readonly requiresDurableState: boolean;
  readonly permitsPublicIngress: boolean;
}

export type DeploymentFallbackKey = "GITGECKO_DB_PATH" | "GITGECKO_AUTH_DB_PATH";

export type Environment = Readonly<Record<string, string | undefined>>;

/** Read one optional environment value without allowing whitespace to activate a feature. */
export const readConfiguredEnv = (env: Environment, key: string): string | undefined => {
  const value = env[key]?.trim();
  return value || undefined;
};

/** Validate deployment ownership wherever a runtime resolves its trust mode. */
const configuredDeploymentOperator = (
  env: Environment,
  mode: DeploymentMode,
): DeploymentOperator | undefined => {
  const operator = readConfiguredEnv(env, "GITGECKO_DEPLOYMENT_OPERATOR");
  if (operator !== undefined && operator !== "gitgecko" && operator !== "customer") {
    throw new Error("GITGECKO_DEPLOYMENT_OPERATOR must be 'gitgecko' or 'customer'.");
  }
  if (mode === "local" && operator === "gitgecko") {
    throw new Error("Local standalone deployments cannot be operated by GitGecko.");
  }
  return operator;
};

/** Resolve one deployment mode for every runtime plane. */
export const resolveDeploymentMode = (
  env: Environment,
  fallbackKey?: DeploymentFallbackKey,
): DeploymentMode => {
  const configured = readConfiguredEnv(env, "GITGECKO_DEPLOYMENT_MODE");
  let mode: DeploymentMode;
  if (configured !== undefined) {
    if (configured !== "local" && configured !== "cloud") {
      throw new Error("GITGECKO_DEPLOYMENT_MODE must be 'local' or 'cloud'.");
    }
    mode = configured;
  } else {
    mode = fallbackKey && readConfiguredEnv(env, fallbackKey) ? "cloud" : "local";
  }
  configuredDeploymentOperator(env, mode);
  return mode;
};

/**
 * Separate runtime trust from infrastructure ownership.
 *
 * Private/on-prem operation keeps cloud-grade auth, persistence, and ingress
 * rules; only the accountable operator changes. This prevents a customer-run
 * service from falling through the account-free standalone path.
 */
export const resolveDeploymentProfile = (
  env: Environment,
  fallbackKey?: DeploymentFallbackKey,
): DeploymentProfile => {
  const mode = resolveDeploymentMode(env, fallbackKey);
  const configuredOperator = configuredDeploymentOperator(env, mode);
  if (mode === "local") {
    return {
      id: "standalone",
      mode,
      operator: "customer",
      requiresAuthentication: false,
      requiresDurableState: false,
      permitsPublicIngress: false,
    };
  }
  const operator = configuredOperator ?? "gitgecko";
  return {
    id: operator === "customer" ? "private-cloud" : "managed-cloud",
    mode,
    operator,
    requiresAuthentication: true,
    requiresDurableState: true,
    permitsPublicIngress: true,
  };
};
