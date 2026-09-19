# Frontend contract

- `web/index.html`, `web/styles.css`, `web/app.js`, and the dependency-light `web/core/`, `web/integration/`, and `web/features/` modules are the standalone web surface. They must work when served from the repository root without a bundler.
- Backend is the source of truth for verdicts, effective thresholds, line context, incidents and scope. Frontend never invents a state from a single metric.
- User-facing labels stay in Russian. Keep API field names only in evidence/details.
- All API calls go through `web/core/api.mjs`; feature boundaries call its `/api` + `/api/v1` alias helper and do not handle bearer tokens in DOM code.
- Authentication/session state is owned by `web/core/session.mjs`; capability checks are owned by `web/core/capabilities.mjs`.
- Map initialization and current/historical registry joins are owned by `web/integration/map-integration.mjs`; `web/map.js` and `web/data-model.js` remain the frozen map/data-model runtime.
- Incidents, reports/exports, notifications, admin, audit, line reads, and ProviderCase requests stay in their explicit `web/features/*.mjs` boundaries even while later tasks build their views.
- Loading, empty, error, and permission states must be visible and actionable.
- Status colors are never the only signal: each status badge has text and a reason/details affordance.
- Any provider-case draft must be visibly marked `Черновик`, editable, and sent only by an explicit human action.
- Responsive behavior: at ≤960px collapse the rail and stack map/list; at ≤640px preserve the primary line action and make tables horizontally scrollable.
- Respect `prefers-reduced-motion`; focus rings must remain visible for keyboard users.
