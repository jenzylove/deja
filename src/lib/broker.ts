/**
 * Execution-provider seam. Deja's decision engine is broker-agnostic: a PASS
 * decision is handed to an ExecutionProvider, which either simulates the fill
 * in paper (the default) or routes a real order through a broker adapter.
 *
 * This file defines the seam and the fail-closed default. No broker adapter is
 * wired, by design and for safety:
 *
 *  - BROKER_ENABLED is not set -> paper execution (canExecute() true).
 *  - BROKER_ENABLED is "true"  -> the provider reports broker mode but
 *    canExecute() is FALSE: real routing is NOT implemented, so every attempted
 *    real order fails closed and never reaches a marketplace. No fake fill, no
 *    real money, no silent success.
 *
 * Wiring a real exchange means: user-provided broker credentials, an approved
 * spending budget, and an adapter that implements placeOrder() against that
 * broker's trade API behind this same interface. That is explicitly out of
 * scope until those credentials and an explicit authorization exist.
 */

export type ExecutionMode = "paper" | "broker";

export interface ExecutionProvider {
  readonly mode: ExecutionMode;
  /** True when the provider can actually place/close a real order today. */
  canExecute(): boolean;
  /** Human label for the UI / telemetry. Never claims real execution when paper. */
  label(): string;
}

export const PAPER_EXECUTION: ExecutionProvider = {
  mode: "paper",
  canExecute: () => true,
  label: () => "paper simulator",
};

/**
 * Fail-closed broker marker. Present only when a deployment explicitly sets
 * BROKER_ENABLED=true, but because no real broker adapter is registered,
 * canExecute() stays false and any real order attempt must be refused.
 */
export const BROKER_STUB: ExecutionProvider = {
  mode: "broker",
  canExecute: () => false,
  label: () => "broker (not wired - real routing disabled)",
};

export function resolveExecutionProvider(environment: Readonly<Record<string, string | undefined>> = process.env): ExecutionProvider {
  return environment.BROKER_ENABLED === "true" ? BROKER_STUB : PAPER_EXECUTION;
}