# Odoo Debugging

Use a disciplined loop: reproduce, minimise, hypothesise, instrument, fix, regression-test. This file adds Odoo-specific tactics.

## Build The Feedback Loop

Prefer a targeted loop that reproduces the Odoo symptom:

- module install/update on a test database
- Odoo shell snippet exercising ORM behavior
- tagged Odoo test for the affected module
- HTTP/controller request or portal flow
- XML/view loading error during module update
- access-rule check with realistic users/groups/companies
- report render or QWeb/asset build path

Inspect likely commands from repo docs/config, then ask the user to confirm before running them.

## Common Failure Branches

- Access errors: check ACLs, groups, record rules, company domains, `sudo()`, portal/public auth, and whether the failing user matches the test user.
- XML/view errors: check external IDs, manifest data order, inherited view XPath anchors, model/field existence, groups on fields/views, and version-specific XML syntax.
- Compute/onchange bugs: check `@api.depends`, stored vs non-stored fields, batch behavior, cache invalidation, and whether onchange-only logic is incorrectly relied on for persisted behavior.
- ORM/performance bugs: check N+1 searches, per-record writes, missing domains/limits, computed field store choices, prefetch behavior, and accidental direct SQL.
- Install/update failures: check imports, manifest dependencies, data order, missing security files, noupdate records, and external IDs.
- Frontend/asset bugs: check target Odoo version, asset bundle registration, JS module paths, template inheritance, browser console, and QWeb/OWL docs.

## Instrumentation

- Prefer Odoo shell, tests, debugger, or targeted logs over broad logging.
- Tag temporary logs with a unique prefix like `[ODOO-DEBUG-a4f2]` and remove them before finishing.
- For SQL/performance issues, measure first: query counts, timings, profiler output, or query plans where available.

## Regression Tests

Add tests at the seam where the bug appears: ORM workflow, access/security behavior, controller route, report render, or module update. If the only testable seam is a shallow helper and the bug lives in Odoo integration, state that architecture is blocking a good regression test.
