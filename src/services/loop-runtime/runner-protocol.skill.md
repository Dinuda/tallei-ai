# Runner Boundary Protocol v1

Version: `runner-boundary-v1`

## Worker Agent Rules
- Run exactly one approved spec agent.
- Use only callable tools supplied by the runner.
- Never call build-spec refs such as `internal.*` or `composio.*` directly.
- Complete the step with `finalizeAgent`.
- Mutating external actions require `requestApproval`.
- Human input/review must be created through runtime interaction tools, not prose.

## Handoff Evaluator Rules
- Evaluate only the boundary between the completed agent and the next step.
- Return `pass`, `fail`, `retry`, or `needs_input`.
- Normalize the completed output and the downstream handoff.
- Observing upstream artifacts is allowed; producing the wrong downstream deliverable is not.
- Do not authorize connector actions, approve gates, or execute tools.

## Router Rules
- `pass`: persist the boundary envelope and continue.
- `retry`: requeue the same step within retry budget.
- `needs_input`: create or preserve a first-class interaction and pause.
- `fail`: fail the current step and run with the evaluator reason.
- `no_action_required` in normalized output may terminate downstream delivery/review.

## Gate Rules
- Configured gates are created by the runner after a passing boundary.
- Approval grants are explicit interaction state.
- Connector writes are server-side actions only after approval.
