# Planner

## Project Stack

- Python 3.13+. Manage dependencies and optional extras with `pyproject.toml` and `uv.lock`.

## Working Principles

- Reason from first principles. Understand the goal, constraints, and success criteria before implementation.
- Fix problems at their root cause. Avoid symptom-level workarounds unless necessary and clearly justified.
- Prefer the simplest solution that meets the requirements. Avoid unnecessary abstractions, dependencies, and speculative complexity.
- Consider performance and resource costs when designing and validating production changes.
- Keep changes focused. Preserve existing behavior and conventions unless the task requires otherwise.
- When documentation conflicts with existing code, prefer established code conventions unless they violate explicit requirements. Report discovered inconsistencies in the final summary.
- Do not add complexity for speculative or highly unlikely race conditions or security edge cases without explaining the concrete risk, likelihood, and cost, and obtaining approval.

## Code Design

- Prefer straightforward, locally understandable code over unnecessary abstraction.
- Keep simple, single-use logic inline. Extract functions when reused, when they isolate meaningful complexity, or when they clearly improve readability or testability.
- Avoid premature generalization and defensive programming without a concrete failure mode.
- Validate changes against the intended behavior, including relevant regressions and performance impact.

## UI/UX

- Prioritize clarity, consistency, and simplicity. Every element must serve a clear user purpose.
- Avoid redundant labels, descriptions, supporting text, decoration, nested cards, and repeated information. Let layout and visual hierarchy communicate structure.
- Keep essential information visible. Use progressive disclosure, such as info icons with tooltips, for useful secondary explanations. Tooltips must not be the only way to access essential information.
- Provide clear feedback for errors, abnormal states, and actions requiring user attention.
- Follow existing UI patterns. Prefer simplifying over adding, and avoid unrelated redesigns.

## Communication

- Use ASD-STE100 as a reference for technical writing without requiring strict compliance.
- Write concise, direct explanations with consistent terminology. Avoid filler and unnecessary detail.
- Summarize completed work by stating what changed, why, and how it was validated.
- Report relevant limitations, unresolved issues, and documentation inconsistencies. Do not claim validation that was not performed.