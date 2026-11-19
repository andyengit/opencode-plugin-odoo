# Odoo Manifest And Docs Sync

Use when updating `__manifest__.py`, module README files, or existing `static/description/` docs to match what the addon actually implements.

## Workflow

1. Inspect the module before editing docs: manifest, models, views, security, data, wizards, reports, controllers, assets, tests, and existing docs.
2. Infer implemented behavior from code, not aspirations.
3. Write polished, benefit-oriented copy, but every claim must be directly supported by code.
4. Update `__manifest__.py` metadata and existing docs. Create missing README/app-store docs only when the user asks or the repo already has that convention.
5. Validate dependencies and data ordering conservatively.

## What To Extract From Code

- new and extended models
- important fields and computed behavior
- user workflows exposed through views, menus, actions, reports, controllers, website/portal, or wizards
- security groups, ACLs, record rules, and access expectations
- data records, scheduled actions, sequences, templates, and assets
- tests or known verification seams

## Manifest Policy

- `summary`: short user-facing value statement supported by implemented behavior.
- `description`: concise explanation of the module's actual workflows and technical scope.
- `depends`: add proven missing dependencies from imports, `_inherit`, XML refs, assets, external IDs, or data records. Do not remove uncertain dependencies automatically; flag them.
- `data`: ensure listed files exist and are load-safe. Fix ordering only when evidence is clear.
- `demo`: keep demo/sample data out of production `data` unless intentionally installed.

## Docs Policy

- Prefer clear business outcomes over internal implementation details.
- Mention technical scope when it helps users/admins understand installation, permissions, or configuration.
- Do not claim integrations, reports, automation, permissions, dashboards, or workflows unless the code proves them.
- If code and existing docs disagree, state the mismatch and update docs to code unless the user says the code is wrong.

## Final Check

- Manifest dependency claims match code/XML refs.
- Data files exist and load in plausible order.
- Security-sensitive features are documented accurately.
- Marketing tone remains truthful and code-supported.
