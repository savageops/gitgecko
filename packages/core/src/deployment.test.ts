import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readConfiguredEnv, resolveDeploymentMode, resolveDeploymentProfile } from "./deployment.js";

describe("deployment configuration owner", () => {
  it("treats blank values as unset", () => {
    assert.equal(readConfiguredEnv({ VALUE: "  " }, "VALUE"), undefined);
    assert.equal(resolveDeploymentMode({ GITGECKO_DEPLOYMENT_MODE: "  " }), "local");
  });

  it("infers cloud only from the caller's durable control path", () => {
    assert.equal(resolveDeploymentMode({ GITGECKO_DB_PATH: "/data/control.db" }, "GITGECKO_DB_PATH"), "cloud");
    assert.equal(resolveDeploymentMode({ GITGECKO_AUTH_DB_PATH: "/data/auth.db" }, "GITGECKO_AUTH_DB_PATH"), "cloud");
    assert.equal(resolveDeploymentMode({ GITGECKO_DB_PATH: "/data/control.db" }, "GITGECKO_AUTH_DB_PATH"), "local");
  });

  it("lets explicit local mode override durable-path inference", () => {
    assert.equal(resolveDeploymentMode({ GITGECKO_DEPLOYMENT_MODE: "local", GITGECKO_DB_PATH: "/data/control.db" }, "GITGECKO_DB_PATH"), "local");
  });

  it("accepts explicit cloud mode after trimming", () => {
    assert.equal(resolveDeploymentMode({ GITGECKO_DEPLOYMENT_MODE: " cloud " }), "cloud");
  });

  it("rejects invalid explicit modes", () => {
    assert.throws(() => resolveDeploymentMode({ GITGECKO_DEPLOYMENT_MODE: "staging" }), /must be 'local' or 'cloud'/);
  });

  it("projects an account-free standalone profile by default", () => {
    assert.deepEqual(resolveDeploymentProfile({}), {
      id: "standalone",
      mode: "local",
      operator: "customer",
      requiresAuthentication: false,
      requiresDurableState: false,
      permitsPublicIngress: false,
    });
  });

  it("projects GitGecko-operated cloud as the managed profile", () => {
    assert.deepEqual(resolveDeploymentProfile({ GITGECKO_DEPLOYMENT_MODE: "cloud" }), {
      id: "managed-cloud",
      mode: "cloud",
      operator: "gitgecko",
      requiresAuthentication: true,
      requiresDurableState: true,
      permitsPublicIngress: true,
    });
  });

  it("keeps customer-operated private cloud on cloud security semantics", () => {
    const profile = resolveDeploymentProfile({
      GITGECKO_DEPLOYMENT_MODE: "cloud",
      GITGECKO_DEPLOYMENT_OPERATOR: "customer",
    });
    assert.equal(profile.id, "private-cloud");
    assert.equal(profile.mode, "cloud");
    assert.equal(profile.requiresAuthentication, true);
    assert.equal(profile.requiresDurableState, true);
    assert.equal(profile.permitsPublicIngress, true);
  });

  it("rejects invalid ownership and a managed operator in local mode", () => {
    assert.throws(
      () => resolveDeploymentMode({ GITGECKO_DEPLOYMENT_OPERATOR: "vendor" }),
      /must be 'gitgecko' or 'customer'/,
    );
    assert.throws(
      () => resolveDeploymentMode({ GITGECKO_DEPLOYMENT_MODE: "local", GITGECKO_DEPLOYMENT_OPERATOR: "gitgecko" }),
      /cannot be operated by GitGecko/,
    );
  });

  it("allows an explicit customer operator for standalone mode", () => {
    assert.equal(resolveDeploymentProfile({ GITGECKO_DEPLOYMENT_OPERATOR: "customer" }).id, "standalone");
  });
});
