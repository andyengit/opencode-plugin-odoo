# Odoo Conventions

Compact checklist. Consult Odoo docs or `$ODOO_SOURCE` for exact behavior when version-sensitive.

## Module Structure

- Module directory names use lowercase underscores, never hyphens.
- `__manifest__.py` names only real dependencies and lists data files in load-safe order.
- Standard folders: `models/`, `views/`, `security/`, `data/`, `wizard/`, `report/`, `controllers/`, `static/`, `i18n/`, `tests/`.
- Keep imports wired through `__init__.py` files.

## Python Models

- Model technical names use dots, for example `sale.order.line`.
- Classes use CamelCase matching the model concept.
- Use `_inherit` for extension and `_inherits` for delegation intentionally.
- Fields use lowercase underscores. Many2one ends in `_id`; One2many/Many2many ends in `_ids`; booleans start with `is_`, `has_`, or `can_`.
- Compute, onchange, and constraint methods use `_compute_`, `_onchange_`, and `_check_` prefixes.
- Prefer ORM batch operations over per-record writes/searches.
- Do not call `self.env.cr.commit()` in business methods.
- Use `sudo()` only at explicit trust boundaries and document why access elevation is correct.

## XML, Views, And Data

- XML IDs are stable and descriptive.
- View IDs follow `view_{model}_{type}[_suffix]` where practical.
- Actions and menus are named by model or purpose.
- User-facing strings are translatable.
- Keep inherited views narrow: target stable anchors and avoid broad XPath rewrites.

## Security

- Every new persistent model needs appropriate `ir.model.access.csv` entries.
- Record rules must be tested against realistic users, groups, and company contexts.
- Portal/public controllers need explicit auth, access, and data exposure review.
- Check groups, ACLs, record rules, `sudo()`, domains, and multi-company isolation together.

## Manifest Data Order

- Groups/security XML before access CSV.
- Access CSV before views that expose models.
- Base/master data before views, actions, reports, or menus that reference it.
- Views before menus/actions that depend on them when applicable.
- Demo data belongs in `demo`, not `data`, unless intentionally installed in production.

## Tests

- Prefer Odoo behavior seams: ORM flows, controllers, reports, access rules, and user-visible workflow effects.
- Use helper unit tests only when helpers hide real reusable logic.
- Include access/security tests for changed permissions or record rules.
