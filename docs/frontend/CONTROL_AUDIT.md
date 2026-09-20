# Frontend control audit

Status: TASK-020, 2026-09-20. This is the reviewable control-to-effect map for
the rebuilt frontend. Controls are rendered only in the state where the listed
effect is available.

| Surface | Control | Effect | Capability / confirmation | Duplicate decision |
|---|---|---|---|---|
| Map | Search and district/provider/status/coverage selectors | Filter real registry/line rows and redraw map/counts | `line.read`; frontend state | One compact filter island |
| Map | Refresh | Reloads `/lines` and registry assets | `line.read`; no confirmation | One global map refresh |
| Map | Zoom in/out/reset | Calls frozen Leaflet map API | Frontend state | One custom tool rail; native zoom disabled |
| Map | Marker, cluster member, popup/detail | Selects a real registry/line object or opens detail | `line.read`; read-only | Popup and drawer have different object scope |
| Map | Locale/theme | Persists frontend preference and reapplies presentation | Frontend-only | One control for each preference |
| Account | Admin / audit | Navigates to secondary capability-gated workspace | `admin.manage` / `audit.read` | Not in primary navigation |
| Account | Logout | Revokes current session then clears local token | Auth session; no destructive confirmation for current session | One account action |
| Notifications | Open/close/refresh | Loads real `/notifications`; no unread badge or mark-read action | `notification.read` | Utility only; no dashboard copy |
| Incidents | Status/severity filters, refresh, row/detail, open line | Filters returned incidents, reloads list, reads detail, focuses real line | `incident.read`; comment has `incident.update` + confirmation | One refresh scoped to incidents |
| Incidents | Comment | Appends a real incident event and renders server response | `incident.update` + explicit confirmation | No optimistic success |
| ProviderCase | Prepare/AI draft/send/retry | Calls real provider-case endpoints | Provider capabilities; confirmation and human review before external send | Only in incident context |
| Reports | Filters/apply/refresh | Queries supported historical report endpoints | `report.read` | One report refresh |
| Reports | Evidence preview | Opens server HTML evidence report | `report.read`; read-only | One contextual evidence action |
| Reports | Export preview/download | Calls `/exports/preview` or `/exports` | `report.export`; read/download | One export form in Reports |
| Admin | Resource selector/refresh | Loads selected real admin resource | Exact admin capability | Secondary workspace |
| Admin | JSON create/update editor | Calls real POST/PUT admin endpoint after server response | Resource capability; confirmation; destructive fields require stronger confirmation | One editor per selected resource |
| Admin | Device block/unblock/rotate | Calls real device action endpoint | `admin.devices`; confirmation | Row-scoped actions only |
| Admin | Impact preview | Calls real `/admin/impact-preview`, explicitly non-mutating | `admin.manage`; no confirmation | Shown only for policy/contract/line resources |
| Admin | Agent update | Calls real `/admin/agent-updates` | `admin.manage`; confirmation | Shown only for agent/device resources |
| Audit | Filters/refresh/log technical details | Reads `/audit`; raw values are behind `<details>` | `audit.read` | One audit refresh |
| Audit | Agent version/device expansion | Reads `/agent-versions` and scoped devices | `audit.read` | Secondary diagnostic tab |

## Audit findings

- No static button has an empty handler or a reference-only label.
- Global refresh, map reset, evidence preview and report export have one
  justified placement per scope. Responsive CSS changes layout only; it does
  not duplicate controls.
- Notification unread count/read mutation is intentionally absent because the
  backend exposes no unread counter or mark-read route.
- Admin impact preview and agent update controls are conditional on resource
  context; they are not rendered as universal buttons.
- Mutations render a pending state and only show the success message after the
  awaited backend call resolves. Errors leave the previous state visible.

The browser-level `UI-001`/`UI-002` checks remain in the acceptance harness;
the static/unit checks in `web/accessibility-responsive.test.cjs` and this
table cover the current source-level inventory.
