# Frontend contract

- `web/index.html`, `web/styles.css`, and `web/app.js` are the standalone web surface. They must work when served from the repository root without a bundler.
- Backend is the source of truth for verdicts, effective thresholds, line context, incidents and scope. Frontend never invents a state from a single metric.
- User-facing labels stay in Russian. Keep API field names only in evidence/details.
- All API calls go through the small `api()` wrapper in `web/app.js`; do not scatter bearer-token handling across components.
- Loading, empty, error, and permission states must be visible and actionable.
- Status colors are never the only signal: each status badge has text and a reason/details affordance.
- Any provider-case draft must be visibly marked `Черновик`, editable, and sent only by an explicit human action.
- Responsive behavior: at ≤960px collapse the rail and stack map/list; at ≤640px preserve the primary line action and make tables horizontally scrollable.
- Respect `prefers-reduced-motion`; focus rings must remain visible for keyboard users.
