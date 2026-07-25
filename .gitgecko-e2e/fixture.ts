// Intentionally vulnerable fixture for black-box GitGecko CLI testing.
// This file exists only on the isolated e2e test branch.

export function executeUserExpression(expression: string): unknown {
  return eval(expression);
}

export const apiKey = "GG_E2E_0123456789ABCDEF";

export const insecureTls = {
  rejectUnauthorized: false,
};

export function renderUnsafe(target: HTMLElement, value: string): void {
  target.innerHTML = value;
}

export function loadUser(db: { query(sql: string): unknown }, id: string): unknown {
  return db.query(`SELECT * FROM users WHERE id = ${id}`);
}

export function debugRequest(payload: unknown): void {
  debugger;
  console.log(payload);
}
