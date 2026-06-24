# Builder Repair Protocol

This protocol defines deterministic repair behavior for builder-time validation failures.

Scope:
- builder tool-input validation failures
- builder command input validation failures

Outcomes:
- `repair_and_retry`
- `pause_for_repair`
- `fail_terminal`

Policy:
1. Initial attempt runs normally.
2. If validation fails and the failure is repairable, attempt automatic repair.
3. Retry within the same builder turn with a fixed budget of `2` repair attempts.
4. Keep repair retries silent.
5. If the budget is exhausted, emit one repair interaction and pause the builder in the same state.
6. If the failure is outside builder repair scope, fail terminally.

Retryable by default:
- malformed JSON
- truncated JSON
- missing required field when a deterministic normalizer can repair it
- enum mismatch when a deterministic normalizer can repair it
- array length violations when a deterministic normalizer can repair it

Pause immediately:
- missing user choice
- unavailable required tool
- unavailable required connector
- incompatible state transition
- missing upstream artifact

Terminal:
- repeated internal exceptions with no deterministic repair path
- infrastructure failures outside builder validation repair scope

Transcript policy:
- silent then surface
- only one visible repair interaction after retry exhaustion
- never expose raw schema stacks unless needed to identify exact missing fields
