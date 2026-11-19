# Odoo Codebase Exploration

Use when the user needs a map of an unfamiliar Odoo repo or addon before changing it.

## Workflow

1. Detect repo layout: core Odoo checkout, custom addons repo, monorepo, or single addon.
2. Locate addons and read manifests first. Build the dependency picture from `depends`, imports, XML refs, and asset bundles.
3. Map models: `_name`, `_inherit`, `_inherits`, fields, constraints, computes, onchanges, actions, and business methods.
4. Map UI and integration: views, menus, actions, reports, controllers, website/portal routes, assets, QWeb/OWL.
5. Map security: groups, access CSV, record rules, `sudo()`, portal/public exposure, company domains.
6. Map data and automation: data XML/CSV, scheduled actions, server actions, sequences, mail templates, demo data.
7. Map tests and verification commands, but ask before running commands.

For large repos, use parallel exploration split by concern: addons/manifests, models, views/assets, security/controllers, data/tests.

## Output Format

Return a practical module map:

- Addons: what each relevant addon does and depends on.
- Core models: new/extended models and important fields/methods.
- User workflows: views, menus, actions, reports, controllers, or portals involved.
- Security shape: ACLs, groups, record rules, sudo/public risks, company isolation.
- Data/automation: loaded records, cron/server actions, sequences, templates.
- Test/verification seams: existing tests and likely commands, pending user confirmation.
- Where to change what: recommended files/seams for the requested work.

Avoid exhaustive inventories unless the user asks. Optimize for navigation and safe change.
