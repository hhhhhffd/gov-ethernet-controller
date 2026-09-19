# TASK-020 Public TLS/ACME Acceptance Evidence

Date: 2026-09-19

Overall status: **BLOCKED_EXTERNAL**

This record separates local production-topology evidence from the required
public-DNS/ACME acceptance. No public PASS is claimed from configuration
inspection or from the localhost certificate.

## External gate

The environment had no `LINKWATCH_PUBLIC_HOST`, `LINKWATCH_PUBLIC_URL`, or
`LINKWATCH_TLS_EMAIL` values. The only documented hostname is the placeholder
`monitoring.example` from `.env.prod.example`; it is not a controlled test DNS
name in this environment.

Command:

```bash
env LINKWATCH_PUBLIC_URL=https://monitoring.example \
  ./scripts/production-tls-smoke.sh
```

Result:

```text
curl: (6) Could not resolve host: monitoring.example
HTTP endpoint did not redirect (status=unknown)
production-tls-smoke exit=1
```

Therefore there is no evidence of a real ACME issuance, public certificate
chain, public redirect, public protected endpoint, or persistence of a real
ACME certificate after restart. The required external acceptance remains
`BLOCKED_EXTERNAL`.

## Local/configuration evidence

These checks passed and do not replace the external gate:

| Check | Result |
| --- | --- |
| `docker compose -f docker-compose.prod.yml config --quiet` with non-secret placeholder values | PASS |
| Caddy `2.10-alpine` `caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile` | PASS (`Valid configuration`) |
| `bash -n scripts/production-tls-smoke.sh` | PASS |
| Production Compose boundary | PASS: `linkwatch-server` has `expose: 8080` and no host `ports`; Caddy publishes only `80/443`; PostgreSQL is loopback-only |
| Runtime container inspection | PASS: `linkwatch-task020-linkwatch-server-1` reported `8080/tcp: null`; Caddy reported host `80/443` mappings |

Caddy validation emitted its existing informational warning that
`header_up X-Forwarded-For` is unnecessary because it is also the default
reverse-proxy behavior. No TLS stack or deployment file was changed for this
acceptance task.

## Isolated localhost runtime evidence

An isolated project named `linkwatch-task020` was started from the existing
production Compose file with `LINKWATCH_PUBLIC_HOST=localhost`, separate
temporary PostgreSQL/Caddy volumes, and no repository changes. The stack built
and became healthy.

| Request/check | Observed result |
| --- | --- |
| `GET http://localhost/health/ready` | `308`, `Location: https://localhost/health/ready` |
| `GET https://localhost/health/ready` | `200`, `{"service":"linkwatch-server","status":"ready"}` |
| `GET https://localhost/api/v1/lines` without credentials | `401` |
| HTTPS response headers | `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` |
| Local certificate | SAN `DNS:localhost`, issuer `Caddy Local Authority - ECC Intermediate`; this is not ACME |
| Caddy restart persistence | PASS locally: SHA-256 fingerprint stayed `A9:CA:51:22:A2:B7:5B:C5:26:98:8F:77:03:8B:59:F7:76:05:6C:22:D2:7C:B3:F8:27:96:FE:0C:A4:F2:81:41` and readiness returned `200` after restart |
| Existing `scripts/production-tls-smoke.sh` with Caddy local root CA | PASS for `https://localhost`; local-only evidence, not public ACME evidence |

The isolated containers, network, and named volumes were removed with
`docker compose ... down -v --remove-orphans` after the run. The pre-existing
development containers and unrelated worktree changes were not touched.

## Required follow-up for PASS

Run the existing script against an approved hostname whose DNS points to the
deployment and whose TCP `80/443` are reachable:

```bash
LINKWATCH_PUBLIC_URL=https://<controlled-test-host> \
  ./scripts/production-tls-smoke.sh
```

Then make a real Caddy restart and repeat the HTTPS certificate/readiness
request. Record the actual ACME issuer/subject, redirect response, required
headers, protected endpoint status, and the before/after certificate identity.
Only that evidence can change TASK-020 from `BLOCKED_EXTERNAL` to `PASS`.
