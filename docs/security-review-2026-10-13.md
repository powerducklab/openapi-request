# Security review — 2026-10-13

Scope: Protocol execution, scripts, runtime dependency tree and transport bounds.

Upgrade gRPC and MCP SDK security patch floors, plus proxy-addr and fast-uri in the published lock. Pin Handlebars 4.7.10 with a published npm-shrinkwrap so the upstream exact 4.7.9 pin cannot silently reintroduce it. Remaining advisory triage: Postman dynamic variables do not call Faker helpers.fake; ASAP uses key parsing/signing, not node-forge RSA signature verification. Those upstream dependencies remain flagged and are not claimed fixed; do not accept arbitrary untrusted scripts as a security boundary.

Validation: package type checks, existing automated tests, targeted regression tests for changes, and release build/package checks. The complete pre-change test/type-check baseline passed for all 17 owned libraries. Final release validation is recorded by the release workflow.

This is a focused P0/P1 review, not a guarantee that all vulnerabilities are absent. npm advisory severity alone is not evidence that a particular application path is exploitable.
