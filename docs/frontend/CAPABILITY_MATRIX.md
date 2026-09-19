# Frontend capability matrix

Статус: TASK-002, снимок реализации на 2026-09-20.

Документ описывает фактически доступные frontend-relevant capabilities, а не
желаемый контракт. Источники: `server/internal/api/*`,
`server/internal/auth/auth.go`, `server/internal/database/migrations/001_initial.sql`,
`web/app.js`, `web/index.html`, `web/map.js`, `web/data-model.js` и
`server/internal/api/admin_matrix_integration_test.go`.

## Как читать матрицу

`B` означает `/api`, `B1` — `/api/v1`. Сервер удаляет любой из этих префиксов
перед маршрутизацией (`server/internal/api/server.go:78-85`), поэтому для всех
маршрутов ниже `B` и `B1` являются рабочими алиасами с одинаковыми request и
response. Исключения, где frontend сейчас вызывает только один вариант, явно
отмечены.

Типовой error response сервера — JSON `{"detail":"...","error":"..."}`
(`server/internal/api/server.go:250-260`). Если отдельно не указано иное,
вызов требует `Authorization: Bearer <token>` и JSON request body.

В колонке «Доступ» указаны capability, роль и область видимости. `ADMIN` и
`OBLAST` имеют неограниченную line visibility; остальные роли ограничены
своими `LINE`, `ORGANIZATION`, `DISTRICT` или `PROVIDER` scopes
(`server/internal/auth/auth.go:287-314`). Проверка видимости часто намеренно
возвращает `404`, а не `403`, чтобы не раскрывать чужие объекты.

«Подтверждение» означает обязательное явное подтверждение в UI перед mutation,
если действие изменяет данные, состояние инцидента, доступ или credentials.

## Capabilities, роли и scopes

| Capability | Роли / фактический смысл |
|---|---|
| `line.read`, `incident.read`, `report.read`, `report.export`, `notification.read` | Базовый доступ всех ролей; результат дополнительно ограничен scope. |
| `audit.read` | `ADMIN`, `OBLAST`, `DISTRICT`; `PROVIDER` и `SCHOOL` получают 403. |
| `incident.create` | `ADMIN`, `OBLAST`, `DISTRICT`; UI показывает ручное создание только при capability. |
| `incident.update` | `ADMIN`, `OBLAST`, `DISTRICT`, `PROVIDER`; конкретные event types дополнительно проверяются через `RoleAllows`. |
| `situation.manage` | `ADMIN`, `OBLAST`, `DISTRICT`, `PROVIDER`; merge/split доступны только в допустимом состоянии. |
| `provider_case.draft` | `ADMIN`, `OBLAST`, `DISTRICT`, `PROVIDER`. |
| `provider_case.send` | `ADMIN`, `OBLAST`, `DISTRICT`, `PROVIDER`; UI требует human review перед send. |
| `notification.dispatch` | Только `ADMIN` в admin handler. |
| `admin.manage`, `admin.users`, `admin.devices`, `admin.policies` | Только `ADMIN`; `requireAdmin` не считает `OBLAST` администратором. |

## Auth, session и login

| Назначение / surface | Method + path | Request → response, relevant to UI | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Login modal (`web/app.js:134-162`) | `POST B/login`, `POST B/auth/login`; также `B1/login`, `B1/auth/login` | `{username|login,password}` → `200 {token,token_type:"Bearer",expires_at,user:{id,username,role,role_label,scopes,capabilities}}`; token хранится в `localStorage.vko_token`. | Public; rate limited. | `400` invalid JSON, `401` invalid credentials, `429` с `Retry-After`, `503` auth unavailable, `500` session failure. | Mutation: creates server session. UI has login only; no destructive confirmation. Реальные алиасы соответствуют `server.go:87-98`, `auth_handlers.go:15-89`. |
| Profile bootstrap / auth state | `GET B/auth/me` / `GET B1/auth/me` | No body → current `Principal` with server-authoritative `capabilities`, scopes, role label. | Bearer session. | `200`; `401` missing, invalid, expired or revoked session. | Read. `web/app.js:164-180` also tries `B/me` and `B1/me`; those are dead legacy paths. |
| Logout/session revocation | `POST B/auth/logout`, `POST B1/auth/logout` | No body → `{revoked:true}`; current bearer session is revoked and audit entry written. | Bearer session. | `200`; `401` auth; `500` revoke/audit failure. | Mutation; should be explicit confirmation only if a future UI presents “logout all”, but current UI has no logout control. `auth_handlers.go:99-115`. |

## Operational overview, map, registry and line/device reads

| Назначение / surface | Method + path | Request → UI response | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| KPI overview cards | `GET B/overview`, `GET B1/overview` | Optional scope/filter query → counts (`schools`, `lines`, `devices`, `active_devices`, `fresh_measurements`, `problem_lines`), averages, completeness/data completeness. | `line.read`; scope-filtered. | `200`; `500` database/read failure. | Read. `catalog.go:11-55`. |
| Current operational map points | `GET B/map/points`, `GET B1/map/points` | No body; optional normal auth scope → line points with org/school/provider, lat/lon, role, `state` (`data_state`, `connection_state`, `contract_state`, `recovery_state`, `effective_since`, `updated_at`, `reason`, `evidence_ids`), `status_mode:"CURRENT_OPERATIONAL"`, `period_summary_available:false`. | `line.read`; scope-filtered. | `200`; `500`. | Read. Real route, but current frontend map calls `GET /lines` and joins local registry data instead of this endpoint (`web/app.js:243-280`, `catalog.go:57-104`). |
| Organization registry read | `GET B/organizations`, `GET B1/organizations` | No body → scoped organizations: id, school_id, name, district/district_id, address, coordinates, contacts, active, created_at. | `line.read`; organizations with visible non-deleted lines. | `200`; `500`. | Read. Real route; not directly called by current frontend. |
| Provider registry read | `GET B/providers`, `GET B1/providers` | No body → distinct scoped providers: id, name, support_contact, active, created_at. | `line.read`; scoped through lines. | `200`; `500`. | Read. Real route; not directly called by current frontend. |
| Line list / registry | `GET B/lines`, `GET B1/lines` | Query: `district`, `provider_id`, `role`, `line_status` → array of line/org/school/provider metadata, current state and latest measurement. | `line.read`; `scopeSQL` in `line_handlers.go:57-86`. | `200`; `401`; `500`. Empty data is a valid empty result. | Read. Main production frontend source (`web/app.js:243-280`, `line_handlers.go:190-276`). |
| Line detail drawer | `GET B/lines/{line_id}`, `GET B1/lines/{line_id}` | No body → line context, current state, effective policy/contract and history, primary device, up to 50 measurements with metrics/status/quality/evaluation/policy/contract/context/evidence snapshots, monitoring points and incidents. | `line.read` + line visibility. | `200`; `404` missing/out of scope; `500`. | Read. `line_handlers.go:279-384`. |
| Line context | `GET B/lines/{line_id}/context`, `GET B1/lines/{line_id}/context` | No body → versioned source/line context used by evaluation. | `line.read` + visibility. | `200`; `404`/`500`. | Read; real route, no separate current frontend call. |
| Measurement history | `GET B/lines/{line_id}/measurements`, `GET B1/lines/{line_id}/measurements` | Query `limit`, `offset` → array or `{items,offset,limit,has_more,next_offset}` with measurement/evaluation/evidence fields. | `line.read` + visibility. | `200`; `422` bad pagination; `404`; `500`. | Read; real route. Current detail already carries measurements, while `История →` is an unbound frontend control (`web/app.js:702-727`, `web/index.html:80`). |
| State transition history | `GET B/lines/{line_id}/states`, `GET B1/lines/{line_id}/states` | No body → previous/current states, reason, timestamps, evidence ids, config snapshot. | `line.read` + visibility. | `200`; `404`/`500`. | Read; real route, no current direct frontend call. |
| Device detail | `GET B/devices/{device_id}`, `GET B1/devices/{device_id}` | Query `limit` (1..200), `offset` → device identity, point/line/org/school/provider, current state, latest measurement, history and pagination. | `line.read` + `HasLineScope`. | `200`; `404` missing/out of scope; `422` pagination; `500`. | Read. `web/app.js:806-810`, `line_handlers.go:655+`. |
| Local school/organization registry join | No backend route; `web/data/vko-schools.json`, `web/data/organization-school-map.json`, `web/data-model.js` | Static local assets feed display/map joins; backend `/lines` remains operational source. | Frontend-only. | Asset load/shape failure is a frontend error, not a server capability. | Read-only frontend state; no confirmation. |

## Incidents and situations

| Назначение / surface | Method + path | Request → UI response | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Incident list | `GET B/incidents`, `GET B1/incidents` | Query `line_id`, `status` → id/number, line/school/provider, source/violation/status, recovery, duration, assignee, repeatability, events, evidence chain, provider cases. | `incident.read`; scoped. | `200`; `500`. | Read. |
| Incident detail | `GET B/incidents/{id}`, `GET B1/incidents/{id}` | No body → incident map with events/evidence/provider cases. | `incident.read` + visibility. | `200`; `404`; `500`. | Read. |
| Manual incident | `POST B/incidents`, `POST B1/incidents` | `{line_id,violation_type?,description,assignee?,source?}` → `201` mapped NEW incident; append-only event and audit. | `incident.create`: `ADMIN`, `OBLAST`, `DISTRICT`; line scope. | `400` body, `401`, `403`, `404`, `422`, `500`; a degraded readback fallback does not undo persistence. | Mutation; explicit submit confirmation is appropriate. `incident_handlers.go:280-388`. |
| Incident event / status action | `POST B/incidents/{id}/events`, `POST B1/incidents/{id}/events` | `{event_type, note?, status?}`. Types: `provider_fixed`, `send_to_provider`, `assign` (note required), `status`, `comment`; returns mapped incident. | `incident.update`; event-specific `RoleAllows`, visibility. | `200`; `403`; `404`; `409` closed/recovery conflict or forbidden close; `422` invalid status/input; `500`. `CLOSED` cannot be set without confirmed recovery. | Mutation; status/provider actions require confirmation in UI. `incident_handlers.go:389-486`. |
| Situations list | `GET B/situations`, `GET B1/situations` | No body; open situations whose members are visible → id/title/status/provider/district/violation/affected count/incidents/start/reason/severity. | Bearer; member line scope. | `200`; `500`. | Read. |
| Situation detail | `GET B/situations/{id}`, `GET B1/situations/{id}` | No body → `read_only:true`, projection, `correlation_only:true`, `causal_claim:false`, factors/evidence/grouping, lifecycle, incidents, and server-generated `actions` for merge/split. | Bearer; visible members. | `200`; `404` missing/out of scope/empty; `500`. | Read. The UI must not present correlation as causal evidence. |
| Historical comparison | `GET B/situations/{id}/comparison`, `GET B1/situations/{id}/comparison` | Query `window_minutes` (15..10080) or `from/to` → historical-only controls/treatment rows, measurements, evidence and completeness; `correlation_only:true`. | Bearer; scoped situation. | `200`; `404`; `422` period; `500`. | Read. `web/app.js:775-805`. |
| Live verify | `POST B/situations/{id}/live-verify`, `POST B1/situations/{id}/live-verify` | No body → `202 {status:"REQUESTED",sample_size}` or `200 {status:"NO_ELIGIBLE_DEVICES"}`; creates agent commands for up to four active scoped devices. | Bearer + eligible line scope; handler does not explicitly require `situation.manage`. | `200/202`; `404` situation; `500`. | Mutation/operational action; UI exposes button to all detail viewers, so capability semantics are an implementation unknown. `live_verify.go:24+`. |
| Merge situation | `POST B/situations/{id}/merge`, `POST B1/situations/{id}/merge` | `{situation_ids?,incident_ids?,expected_updated_at?,reason}` plus required `Idempotency-Key` or `X-Request-ID` → `201` action result, replay `200`. | `situation.manage`; visible scope. | `403`; `404`; `409` stale/conflict; `422` missing reason/key or invalid set; `500`. | Mutation; destructive/restructuring, explicit confirmation required. UI uses reason prompt. |
| Split situation | `POST B/situations/{id}/split`, `POST B1/situations/{id}/split` | Same request/idempotency contract → action result. | `situation.manage`; visible scope. | `403`; `404`; `409`; `422`; `500`. | Mutation; explicit confirmation required. `situation_actions.go:34-58`. |

## Reports, analytics, quality passport, evidence and export

| Назначение / surface | Method + path | Request → UI response | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Aggregate report / map historical summary | `GET B/reports/aggregate`, `GET B1/reports/aggregate` | Query period/from/to and filters `line_id`, `district`, `provider`, `device_id`, `organization_id`, `role`, `technology`, `status` → period, measurement count, aggregate min/max/avg, by-line/org/school/district/provider, availability, completeness and durations. | `report.read`; scoped filters. | `200`; `422` period/filter; `500`. | Read. `report_handlers.go:372-493`. |
| Analytics | `GET B/reports/analytics`, `GET B1/reports/analytics` | Query period + filters, `limit`; default 50. JSON → historical-only ranking/time-of-day/trend/comparison, `current_state_used:false`; `format=csv` → attachment. | `report.read`; scoped. | `200`; `413` observation guard; `422`; `500`. | Read/download; no destructive confirmation. `report_analytics.go:153+`. |
| Quality passport | `GET B/reports/quality-passport`, `GET B1/reports/quality-passport` | Query period and optional line → measurements expected/received, completeness, baseline/contract compliance, incident counts/duration/recurrence/recovery narrative, evidence chain/dynamics, availability threshold/status and `sufficient_data`. | `report.read`; scoped. | `200`; `422`; `500`. | Read. |
| Evidence report | `GET B/reports/quality-passport/evidence`, `GET B1/reports/quality-passport/evidence`; alias `B/reports/evidence-report` and `B1/...` | Query period/filter → inline `text/html` evidence-chain report named `linkwatch-evidence-report.html`. | `report.read`; scoped. | `200`; `422`; `500`. | Read/export-like download. Frontend label “PDF-ready”, but response is HTML; no PDF endpoint exists (`evidence_report.go:129+`). |
| Export preview | `GET B/exports/preview`, `GET B1/exports/preview` | Same export query/body fields → `{kind,format,from,to,count,measurement_count,limited,columns,available_columns,schools,devices}`. | `report.export`; scoped. | `200`; `422` invalid kind/format/fields/period; `500`. | Read-only preview; no confirmation. |
| Export data | `GET B/exports`, `POST B/exports`; `B1` aliases | GET query or POST body: `kind/type` (`raw|aggregate`), `format` (`csv|xlsx|json`), period, line/district/provider/device/org/status/role/technology, `device_ids`, `fields/columns`, from/to → attachment (or JSON response). | `report.export`; scoped. | `200`; `413` row limit; `422` validation; `500`. | Read/download; no destructive confirmation. Frontend uses GET with `B` then `B1` fallback (`web/app.js:841-847`). |

## Notifications and actual unread semantics

| Назначение / surface | Method + path | Request → response relevant to UI | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Notification outbox list | `GET B/notifications`, `GET B1/notifications` | Query `source_type`, `status`, `before_id`, `limit` (default 50, max 100) → items with id/source/channel/recipient scope/message/delivery `status`, attempts/errors/retryable/next attempt, generated/sent, `read_at`, line/org/school/district/provider and incident ids. | `notification.read`; scope-filtered. | `200`; `422` bad cursor; `500`. | Read. `web/app.js:543-564` displays delivery status, not read status. |
| Dispatch notification | `POST B/admin/notifications/{id}/dispatch`, `POST B1/admin/notifications/{id}/dispatch` (handler currently lacks an explicit method guard) | No body → `200 SENT`; dispatches through provider and audits. | Exact `ADMIN` only. | `404` already delivered/not found; `502` delivery failure (retryable); auth/permission errors; `500`. | Mutation with external side effect; explicit confirmation required. Not exposed in current frontend admin tabs. `misc_handlers.go:466-488`. |
| Unread count / mark read | No route exists. | DB has `notifications.read_at` (`001_initial.sql:252-265`), and list returns it; there is no count endpoint and no mark-read mutation. | N/A. | `read_at == null` is the only raw-data interpretation, not a server-maintained user unread counter. Delivery `status` is not read state. | Unsupported frontend capability: current UI has no unread badge, read action or read persistence. |

## ProviderCase, draft, AI and send

| Назначение / surface | Method + path | Request → response relevant to UI | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Provider case list | `GET B/provider-cases`, `GET B1/provider-cases` | Query/filter as supported → provider cases with incident/line/provider and delivery status. | `provider_case.draft`/visible provider case scope; handler auth. | `200`; `500`. | Read. |
| Provider case detail | `GET B/provider-cases/{id}`, `GET B1/provider-cases/{id}` | No body → draft/final text, status, delivery metadata, incident/line/provider. | Auth + object scope. | `200`; `404`; `500`. | Read. |
| Create case directly from line | `POST B/provider-cases`, `POST B1/provider-cases` | `{line_id,school_id,provider_id,comment}` → created case. | Provider-case capability + scope. | `201`; `403`; `404`; `422`; `500`. | Mutation; creation submit should be confirmed. |
| Create case from incident | `POST B/incidents/{id}/provider-case/draft`, `POST B1/...` | `{comment?}`; server uses stored evidence → `201 {id,incident_id,draft_text,status:"DRAFT",delivery_status:"PENDING"}`. | `provider_case.send`; `ADMIN/OBLAST/DISTRICT/PROVIDER`; incident scope. | `403`; `404`; `422`; `500`. | Mutation; no external send yet, but explicit create/save action. `incident_handlers.go:487-560`. |
| AI draft | `POST B/provider-cases/{id}/ai-draft`, `POST B1/...` | `{}` + `Idempotency-Key` from UI → generated draft/case response. | `provider_case.draft`; object scope. | `403`; `404`; `409` idempotency/conflict; `422`; provider/AI `5xx`. | Mutation; human review remains required. `web/app.js:815-836`. |
| Send case | `POST B/provider-cases/{id}/send`, `POST B1/.../send` | `{incident_id,final_text,text,reviewed:true}` → case delivery transition/attempt. | `provider_case.send`; object scope. | `403`; `404`; `409`; `422`; retryable/non-retryable delivery errors; `500`. | External side effect; explicit human checkbox and confirmation required. |
| Retry case delivery | `POST B/provider-cases/{id}/retry`, `POST B1/.../retry` | No/limited body → retry persisted delivery attempt. | `provider_case.send`; object scope. | `403`; `404`; `409` not retryable; `422`; delivery/`500`. | External side effect; explicit confirmation. |
| Legacy incident send fallback | `POST B/incidents/{id}/provider-case/send`, `POST B1/...` | Frontend tries this only after provider-case send failure. | None: no matching server route. | `404` is expected dead legacy call. Real send is `/provider-cases/{case_id}/send`. | Unsupported/dead route; do not document as backend capability. |
| “Save as draft” modal cancel | No mutation route is called. | `web/index.html` labels cancel as “Сохранить как черновик”, but `closeCaseModal` only closes the modal. | Frontend-only. | No persistence; user text can be lost. | Unsupported/misleading control; no confirmation or save semantics. |

## Audit and agent versions

| Назначение / surface | Method + path | Request → response relevant to UI | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Audit log | `GET B/audit`, `GET B1/audit`; admin alias `GET B/admin/audit`, `B1/admin/audit` | Filters `actor_id`, `action`, `object_type`, `object_id`, `scope_type/id`, `before_id`, `from/to`, `limit` (1..100), `page` → `{items,page,limit,has_more,next_before_id}`, redacted before/after. | `audit.read`: `ADMIN/OBLAST/DISTRICT`; object visibility applied. | `403` for provider/school, `422` filters/pagination, `500`. | Read. `audit_handlers.go:15-25,147-239`. |
| Observed agent versions | `GET B/agent-versions`, `GET B1/agent-versions` | Pagination → `{items:[{version,device_count,last_seen,source:"observed_telemetry"}],page,limit,has_more,source}`. | `audit.read`; thus not school/provider. | `403`; `422`; `500`. | Read. Frontend calls this from audit view. |
| Devices using observed version | `GET B/agent-versions/{version}/devices`, `GET B1/...` | Pagination → device identity/line/school/org/last seen rows plus version/page metadata. | `audit.read`; scoped. | `403`; `422`; `500`. | Read. |

## Exposed admin resources and mutations

Все admin routes ниже имеют `B`/`B1` aliases и требуют exact `ADMIN`; `OBLAST`
не проходит `requireAdmin`. Current tabs in `web/app.js:849-860` expose only a
subset, which is called out in the surface column. The integration matrix
`server/internal/api/admin_matrix_integration_test.go:40-119` verifies admin
denials and both API aliases.

| Resource / frontend surface | Method + path | Request → response relevant to UI | Доступ | Результат / ошибки | Read или mutation; подтверждение |
|---|---|---|---|---|---|
| Organizations admin tab | `GET B/admin/organizations`; `POST/PUT B/admin/organizations` | GET rows: id/school/name/district/address/coords/contacts/active. Write body: `{id,school_id,name,district,district_id,address,lat,lon,contacts,active}`; create `201`, update `200`; ids immutable. | `admin.manage`, exact ADMIN. | `404`, `409` duplicate/ref conflict, `422`, `500`. | Read or mutation. Create/update confirmation if changing identity or deactivating. |
| Providers admin tab | `GET/POST/PUT B/admin/providers` | GET rows and write body `{id,name,support_contact,active}` → row / `201` / `200`. | exact ADMIN. | `404`, `409`, `422`, `500`. | Read/mutation; confirm deactivation. |
| Lines admin tab | `GET/POST/PUT B/admin/lines` | `{id,organization_id,provider_id,role,technology,technology_id,status}`; role `PRIMARY|RESERVE|INACTIVE`, status `ACTIVE|INACTIVE|DELETED`; versioned context → row. | exact ADMIN. | `404`, `409` primary/monitoring-point conflict, `422`, `500`. | Read/mutation; `DELETED` must require explicit destructive confirmation. |
| Monitoring points admin tab | `GET/POST/PUT B/admin/monitoring-points` | `{id,line_id,location,is_primary,active}` → point row; primary invariants enforced. | exact ADMIN. | `404`, `409`, `422`, `500`. | Read/mutation; confirm changing primary/deactivation. |
| Users admin tab | `GET/POST/PUT B/admin/users` | `{id,username,role,password?,disabled,scopes:[{scope_type,scope_id}]}`; roles `ADMIN|OBLAST|DISTRICT|PROVIDER|SCHOOL`; create may return one-time session token when enabled. | `admin.users`, exact ADMIN. | `404`, `409`, `422`, `500`; password/disabled changes revoke sessions. | Read/mutation; password, disable and scope changes require explicit confirmation. |
| Devices admin tab | `GET B/admin/devices` | Rows: id/hostname/display/point/line/org/school/agent/last_seen/blocked/telemetry fields. | `admin.devices`, exact ADMIN. | `200`; auth/`500`. | Read. |
| Register device | `POST B/admin/devices/register` | `{device_id,monitoring_point_id,agent_version?,display_name}` → `201`, device record and one-time `device_token`. | exact ADMIN. | `404` point; `409` duplicate; `422`; `500`. | Mutation; token issuance needs explicit confirmation/secure handling. |
| Edit device display name | `PUT/PATCH B/admin/devices/{id}` | `{display_name}` → updated device. | exact ADMIN. | `404`, `422`, `500`. | Mutation; ordinary save confirmation optional. |
| Rotate device token | `POST B/admin/devices/{id}/rotate-token` | No body → `200 {device_token:...}`; old token invalidated. | exact ADMIN. | `404`; `500`. | Destructive credential mutation; confirmation required. Current UI has action but no confirmation prompt. |
| Block / unblock device | `POST B/admin/devices/{id}/block`; `/unblock` | No body → `200 {blocked:true|false}`. | exact ADMIN. | `404`; `500`. | Mutation; block is disruptive and requires confirmation. Current UI lacks prompt. |
| Remote device config | `POST B/admin/devices/{id}/config` | `{config:{schedule/probe}}` → `202` desired config version/payload/hash/status `PENDING`. | exact ADMIN. | `404`, `422`, `500`. | Mutation; not exposed in current admin tabs. Apply should be confirmed. `remote_config.go:44+`. |
| Remote device command | `POST B/admin/devices/{id}/commands` | `{command_type,payload,idempotency_key,expires_at?}` → `201` command or `200` idempotent replay. | exact ADMIN. | `404`, `422`, `500`. | Operational mutation; not exposed; explicit confirmation required. `agent_commands.go:63+`. |
| Admin schedule | `GET/POST/PUT B/admin/schedules` | GET `{tests_per_day,performance_tests_per_day,jitter_minutes,light_checks_between}`; write same body, tests 3..5, jitter 0..240 → `200`. | exact ADMIN. | `422`; `500`. | Read/mutation; confirm schedule changes. Current admin resource is exposed. |
| Policies | `GET/POST B/admin/policies` | GET versioned thresholds; POST scope/time/version plus threshold, confirmation, recovery/freshness fields and `reason` → `201` id/version/scope/time; closes open predecessor where valid. | `admin.policies`, exact ADMIN. | `409` overlap, `422`, `500`. | Read/mutation; policy replacement is high impact and requires confirmation. |
| Contracts | `GET B/admin/contracts` (optional `line_id`); `POST B/admin/contracts` | POST `{line_id,valid_from/to,contract_no,contract_date,thresholds,reason}` → `201` immutable version. | `admin.policies`, exact ADMIN. | `409` interval conflict, `422`, `500`. | Read/mutation; contract change requires confirmation. |
| District catalog | `GET/POST/PUT B/admin/catalogs/districts`; aliases `B/admin/districts`, `B/admin/district` | GET `{id,name,active,created_at}`; write `{id,name,active}`; immutable id. | exact ADMIN. | `404`, `405`, `409`, `422`, `500`. | Read/mutation; current admin tab uses catalog path. |
| Technology catalog | `GET/POST/PUT B/admin/catalogs/technologies`; aliases `B/admin/technologies`, `B/admin/technology` | Same catalog shape `{id,name,active}`. | exact ADMIN. | `404`, `405`, `409`, `422`, `500`. | Read/mutation; confirm deactivation. |
| Agent version catalog | `GET/POST B/admin/agent-versions`; `PUT B/admin/agent-versions/{version}` | `{version,recommended,minimum_supported,release_at,checksum,artifact_url,active}` → rows / `201` / `200`; version immutable. | exact ADMIN. | `404`, `409`, `422`, `500`. | Read/mutation; current frontend does not expose this admin resource. |
| Queue agent update | `POST B/admin/agent-updates` | `{manifest,device_ids[1..100]}`; signed HTTPS manifest → `202 {release_id,version,queued,status:"REQUESTED",manifest_sha256}`. | exact ADMIN. | `409`, `422`, `500`. | Operational mutation with device impact; not exposed; explicit confirmation required. `agent_updates.go:88+`. |
| Impact preview | `POST B/admin/impact-preview` | `{line_ids[],from,to,idempotency_key,policy:{...},contract:{...}}` → preview id/status, source period, snapshots, affected lines/measurements/changed/projected/unknown, `actual_truth:"NOT_MUTATED"`, `apply.available:false`. | exact ADMIN; lines must be visible. | `403`, `404`, `409`, `413`/`422`, `500`. | Read-only simulation; no confirmation for preview, but no apply route exists. Current admin UI calls it. |
| Demo reset | `POST B/admin/demo/reset` | No body → `{reset:true}`; non-production only. | exact ADMIN. | `404` in production; auth/`500`. | Destructive mutation; explicit confirmation. Not current admin tab. |
| Admin audit alias | `GET B/admin/audit`, `GET B1/admin/audit` | Same audit filters and page response as public `/audit`. | `audit.read` plus admin route exact ADMIN in current admin router. | `403`, `422`, `500`. | Read; current audit view uses public route. |

## Agent transport routes (not operator UI capabilities)

These are real routes but belong to the native agent protocol, not the browser
operator surface: `POST B/agent/heartbeat`, `POST B/agent/measurements:batch`,
`GET B/agent/config`, `POST B/agent/commands:lease`,
`POST B/agent/commands/{id}:ack`, `GET/HEAD B/agent/probe/download`,
`POST B/agent/probe/upload`, and `POST B/agent/register`. They are listed here
to avoid confusing “every exposed route” with a frontend capability; their
request/response contracts are implemented for `agent/`, not `web/`.

## Frontend-only state (not backend capabilities)

| State | Frontend surface / storage | Backend path | Semantics |
|---|---|---|---|
| Locale | `html lang="ru"` (`web/index.html:1`) and Russian strings in templates. | None. | No locale selector, locale API or persisted locale state. |
| Theme | `meta name="theme-color"`; map uses a fixed Stadia dark tile configuration (`web/map.js:5-12`). | None. | No theme control, preference or backend capability. |
| Viewport | Leaflet map center/zoom, zoom in/out/reset controls; default center `[49.95,82.62]`, zoom `7`, limits 3..18. | None. | Viewport lives in Leaflet memory; no URL/localStorage persistence or viewport API (`web/map.js:205-240`). |
| Filters and view | `search`, district/provider/technology/status/period/date filters, list/map mode, coverage mode, selected line/incident/case, admin resource/editing state. | None directly; filters become query parameters on read routes. | Local UI state; reload resets it. |
| Overlays | Map popup, drawer, incident/provider modal, toast, login modal, loading/error/empty classes. | None. | DOM visibility and selected IDs only; no server-side overlay/session state. |

## Real routes, dead calls and unsupported controls

### Real aliases

- The router strips both `/api` and `/api/v1`; `/api/v1/organizations` and
  `/api/organizations` are explicitly covered by
  `admin_matrix_integration_test.go:83-119`.
- Login aliases used by the frontend (`B/login`, `B/auth/login`, `B1/login`,
  `B1/auth/login`) are real because the router accepts both `/login` and
  `/auth/login`.
- All route paths in the matrices are real under both prefixes unless a row
  explicitly says the frontend only uses one variant.

### Dead legacy frontend calls

- `B/me` and `B1/me`: backend exposes `/auth/me`, not `/me`; `apiTry` reaches
  the valid auth path first.
- `B/organizations/lines`: no matching backend route; the current line list is
  `/lines`.
- `B/incidents/{id}/provider-case/send`: no matching backend route; send uses
  `/provider-cases/{case_id}/send`.

### Controls without a supported backend action

- No logout button, unread badge, mark-read action, locale selector, theme
  selector, persisted map viewport or PDF evidence endpoint.
- The line drawer’s `История →` button is not wired to a handler; history APIs
  exist, but this control does not invoke them.
- Provider modal “Сохранить как черновик” closes without saving; draft creation
  is a separate explicit backend action.
- Admin device block/unblock and token rotation are exposed by the current UI
  without a confirmation prompt, although they are disruptive/destructive
  mutations and this matrix requires confirmation.
- Frontend has a `?demo=1` explicit demo escape hatch and local demo fallback
  paths; production failure is not silently converted to demo data. Demo reset
  is a real admin route but is not an ordinary operator capability.

## Coverage, unknowns and verification notes

Covered: authentication/session lifecycle; all public operator reads and
mutations used by `web/`; map/registry/organizations/lines/devices/providers;
incidents/situations; aggregate/analytics/passport/evidence/export/preview;
notification delivery and raw read semantics; ProviderCase draft/AI/send/retry;
audit and observed agent versions; every current and additional exposed admin
resource; agent transport boundary; `/api` and `/api/v1` aliases; and
frontend-only locale/theme/viewport/overlay state.

Known implementation uncertainties that should not be guessed into UI:

- `live-verify` checks authentication and eligible line scope but does not
  explicitly call `situation.manage`; this differs from merge/split capability
  gating and should be resolved before tightening UI permissions.
- Provider-case list/detail response fields are implemented in handlers but are
  not all rendered by the current frontend; consumers should rely on the actual
  handler response, not modal labels.
- Notification `read_at` is nullable storage, not a user-scoped unread contract;
  no endpoint establishes or changes read state.
- Some route branches do not guard the HTTP method after path matching (notably
  admin notification dispatch and provider-case send/retry); frontend should
  use the documented intended method, while backend hardening is outside
  TASK-002.

No runtime code or endpoint was changed for this document. Verification for this
docs-only change: `git diff --check` and repository status/diff review; runtime
test suites were not run because no runtime/schema code changed.
