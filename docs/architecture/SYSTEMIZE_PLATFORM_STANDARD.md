# Systemize Platform Standard

1st Fire Protection is the first production proving ground for the Systemize TX fire-protection standard.

## Architecture rule

The OS owns business state, workflow state, approvals, permissions, external-resource mappings, audit history, and outcomes. Relevance AI or any future agent vendor may reason and delegate, but it is not the source of truth.

## Stack boundary

- **Control plane:** this application.
- **Durable execution:** code-owned workflow runtime. Inngest is the preferred hosted runtime; the local contract must remain vendor-neutral.
- **Agent reasoning:** Relevance AI and direct model calls.
- **Model access:** provider-neutral model gateway. OpenRouter may be used behind the gateway, but direct providers remain supported.
- **Observability:** Langfuse or equivalent for LLM/agent traces. Business workflow state remains in the OS database.
- **Integrations:** direct APIs or Systemize-owned adapters/MCP first.
- **Computer use:** fallback only when no reliable API/integration exists.

## Required platform capabilities

1. Identity, tenant and office scope.
2. Role and tool permissions.
3. Canonical data model.
4. Event contract.
5. Workflow/run/step ledger.
6. Idempotency and external-resource ledger.
7. Agent/version registry.
8. Model gateway.
9. Integration/tool registry.
10. Human approval policy.
11. Audit trail.
12. Observability and evaluations.
13. Outcome measurement.

## Approval levels

- L0 Observe: autonomous.
- L1 Prepare: autonomous.
- L2 Reversible internal action: usually autonomous.
- L3 External action: approval by default.
- L4 Financial/legal/destructive/employment/security: always approved unless an explicit written policy supersedes it.

## Execution priority

Native API -> Systemize adapter/MCP -> durable code workflow -> agent-platform tool -> browser/computer agent.

## Product abstraction

An AI employee is not required to be one LLM agent. A single employee may combine deterministic steps, schedules, model calls, Relevance workforces, human approvals, and external integrations while appearing as one coherent worker in the OS.
