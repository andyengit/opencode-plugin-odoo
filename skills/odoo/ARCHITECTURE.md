# Odoo Architecture And Refactor Review

Use when assessing addon boundaries, model seams, view structure, security design, or testability.

## Odoo Seams To Inspect

- addon boundaries and manifest dependencies
- model inheritance and delegation choices
- model methods that act as interfaces for workflows
- XML inherited views and action/menu structure
- security groups, ACLs, record rules, and company domains
- controllers, portal/public routes, and request boundaries
- wizards, reports, scheduled/server actions, and data records
- asset bundles, OWL components, and QWeb templates
- tests and verification seams

## Hunt For Friction

Look for:

- addons that depend on too much or mix unrelated business concepts
- shallow wrapper models/methods that only pass through Odoo calls
- business rules duplicated across views, onchanges, controllers, and scheduled actions
- view inheritance that is fragile because it targets unstable structure
- security rules spread so widely that no one seam explains access behavior
- `sudo()` hiding missing permissions or unsafe data exposure
- multi-company behavior implicit in domains rather than modeled clearly
- tests forced onto helpers because the real Odoo seam is too tangled

Apply the deletion test: if deleting a module/method/view helper makes complexity vanish, it was likely shallow; if complexity reappears across many callers, the seam was earning its keep.

## Output Candidates First

Present ranked candidates before proposing detailed interfaces or editing:

- Files/seams involved
- Problem causing friction
- Solution in plain English
- Benefits in locality, leverage, security, and testability
- Risks including migration/load-order/security impacts
- Test impact: which Odoo behavior seam becomes easier to test

Then ask which candidate to explore. Do not design all refactors at once.

## Guardrails

- Respect existing repo conventions. Surface real conflicts only when friction justifies revisiting them.
- Prefer Odoo-native seams before inventing generic abstraction layers.
- One adapter is a hypothetical seam; two adapters make the seam real.
- Keep module boundaries aligned with business concepts, not just technical file types.
