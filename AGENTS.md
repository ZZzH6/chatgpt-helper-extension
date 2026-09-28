# Project Agent Instructions

## Implementation Delegation

- For code changes in this repository, delegate implementation work to a `gpt-6-luna` sub-agent.
- The primary agent handles investigation, task breakdown, review, integration, and verification.
- The primary agent should not directly edit implementation files unless the user explicitly requests it or Luna is unavailable and the user is informed.
- If a Luna sub-agent cannot be started, report that constraint before using another model for implementation.
