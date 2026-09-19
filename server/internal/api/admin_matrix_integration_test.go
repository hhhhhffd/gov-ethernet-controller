package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
)

type adminMatrixFixture struct {
	prefix string
	db     *database.DB
	server *Server

	adminToken    string
	districtToken string
	schoolToken   string

	districtID     string
	technologyID   string
	technologyID2  string
	organizationID string
	providerID     string
	providerID2    string
	lineID         string
	pointID        string
	deviceID       string
	scopeUserID    string
}

func TestAdminMatrixAuthorization(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "development")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	db := openAdminMatrixDB(t)
	t.Cleanup(db.Close)
	fixture := createAdminMatrixFixture(t, db)

	tests := []struct {
		name    string
		method  string
		path    string
		payload interface{}
		token   string
	}{
		{name: "organizations", method: http.MethodPost, path: "/api/v1/admin/organizations", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "devices", method: http.MethodPost, path: "/api/v1/admin/devices/register", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "device block and unblock", method: http.MethodPost, path: "/api/v1/admin/devices/" + fixture.deviceID + "/block", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "device token rotation", method: http.MethodPost, path: "/api/v1/admin/devices/" + fixture.deviceID + "/rotate-token", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "users", method: http.MethodPost, path: "/api/v1/admin/users", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "roles", method: http.MethodPut, path: "/api/v1/admin/users/" + fixture.scopeUserID, payload: map[string]interface{}{"id": fixture.scopeUserID, "username": "unchanged", "role": "PROVIDER"}, token: fixture.districtToken},
		{name: "scopes", method: http.MethodPut, path: "/api/v1/admin/users/" + fixture.scopeUserID, payload: map[string]interface{}{"id": fixture.scopeUserID, "username": "unchanged", "role": "DISTRICT", "scopes": []map[string]string{{"scope_type": "DISTRICT", "scope_id": fixture.districtID}}}, token: fixture.districtToken},
		{name: "providers", method: http.MethodPost, path: "/api/v1/admin/providers", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "lines", method: http.MethodPost, path: "/api/v1/admin/lines", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "monitoring points", method: http.MethodPost, path: "/api/v1/admin/monitoring-points", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "schedule", method: http.MethodPut, path: "/api/v1/admin/schedules", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "thresholds and policies", method: http.MethodPost, path: "/api/v1/admin/policies", payload: map[string]interface{}{"scope_type": "LINE", "scope_id": fixture.lineID}, token: fixture.districtToken},
		{name: "incident confirmation and recovery rules", method: http.MethodPost, path: "/api/v1/admin/policies", payload: map[string]interface{}{"scope_type": "LINE", "scope_id": fixture.lineID, "confirm_count": 2, "recovery_count": 4}, token: fixture.districtToken},
		{name: "districts", method: http.MethodPost, path: "/api/v1/admin/catalogs/districts", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "technologies", method: http.MethodPost, path: "/api/v1/admin/catalogs/technologies", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "contract versions", method: http.MethodPost, path: "/api/v1/admin/contracts", payload: map[string]interface{}{}, token: fixture.districtToken},
		{name: "observed agent versions read boundary", method: http.MethodGet, path: "/api/v1/agent-versions", payload: nil, token: fixture.schoolToken},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			status, _ := adminMatrixRequest(t, fixture.server, tt.token, tt.method, tt.path, tt.payload)
			if status != http.StatusForbidden {
				t.Fatalf("%s returned HTTP %d, want %d", tt.name, status, http.StatusForbidden)
			}
		})
	}
}

func TestOrganizationsEndpointReturnsRowsWithNullableContactTimestamp(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "development")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	db := openAdminMatrixDB(t)
	t.Cleanup(db.Close)
	fixture := createAdminMatrixFixture(t, db)

	for _, path := range []string{"/api/v1/organizations", "/api/organizations"} {
		t.Run(path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			request.Header.Set("Authorization", "Bearer "+fixture.adminToken)
			recorder := httptest.NewRecorder()
			fixture.server.Handler().ServeHTTP(recorder, request)

			if recorder.Code != http.StatusOK {
				t.Fatalf("GET %s returned HTTP %d, want %d; body=%s", path, recorder.Code, http.StatusOK, recorder.Body.String())
			}
			var organizations []map[string]interface{}
			if err := json.Unmarshal(recorder.Body.Bytes(), &organizations); err != nil {
				t.Fatalf("decode GET %s response: %v; body=%s", path, err, recorder.Body.String())
			}
			var fixtureOrganization map[string]interface{}
			for _, organization := range organizations {
				if organization["id"] == fixture.organizationID {
					fixtureOrganization = organization
					break
				}
			}
			if fixtureOrganization == nil {
				t.Fatalf("GET %s organizations = %#v, want the fixture organization", path, organizations)
			}
			if value, ok := fixtureOrganization["contact_updated_at"]; !ok || value != nil {
				t.Fatalf("GET %s contact_updated_at = %#v, want JSON null for the legacy nullable row", path, value)
			}
		})
	}
}

func TestAdminMatrixMutationEvidence(t *testing.T) {
	t.Setenv("LINKWATCH_ENV", "development")
	t.Setenv("LINKWATCH_AUTH_DISABLED", "0")
	db := openAdminMatrixDB(t)
	t.Cleanup(db.Close)
	fixture := createAdminMatrixFixture(t, db)
	adminToken := fixture.adminToken

	createdDistrictID := fixture.prefix + "-created-district"
	createdDistrict := map[string]interface{}{"id": createdDistrictID, "name": fixture.prefix + " Created District", "active": true}
	status, _ := adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/catalogs/districts", createdDistrict)
	if status != http.StatusCreated {
		t.Fatalf("create district status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "district.created", "district", createdDistrictID)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/catalogs/districts/"+createdDistrictID, map[string]interface{}{"id": createdDistrictID, "name": fixture.prefix + " Renamed District", "active": true})
	if status != http.StatusOK {
		t.Fatalf("update district status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "district.updated", "district", createdDistrictID)

	createdTechnologyID := fixture.prefix + "-created-tech"
	createdTechnology := map[string]interface{}{"id": createdTechnologyID, "name": fixture.prefix + " Created Technology", "active": true}
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/catalogs/technologies", createdTechnology)
	if status != http.StatusCreated {
		t.Fatalf("create technology status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "technology.created", "technology", createdTechnologyID)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/catalogs/technologies/"+createdTechnologyID, map[string]interface{}{"id": createdTechnologyID, "name": fixture.prefix + " Renamed Technology", "active": true})
	if status != http.StatusOK {
		t.Fatalf("update technology status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "technology.updated", "technology", createdTechnologyID)

	createdOrganizationID := fixture.prefix + "-created-org"
	organization := adminMatrixOrganizationPayload(createdOrganizationID, fixture.districtID)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/organizations", organization)
	if status != http.StatusCreated {
		t.Fatalf("create organization status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "organization.created", "organization", createdOrganizationID)
	status, body := adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/organizations", organization)
	assertAdminError(t, status, body, http.StatusConflict, "organization id or school_id already exists")
	organization["name"] = fixture.prefix + " Renamed Organization"
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/organizations/"+createdOrganizationID, organization)
	if status != http.StatusOK {
		t.Fatalf("update organization status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "organization.updated", "organization", createdOrganizationID)
	assertLatestAuditSnapshotsContain(t, db, "organization.updated", "organization", createdOrganizationID, "Created Organization", "Renamed Organization")

	createdProviderID := fixture.prefix + "-created-provider"
	provider := map[string]interface{}{"id": createdProviderID, "name": fixture.prefix + " Created Provider", "support_contact": "ops@example.test", "active": true}
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/providers", provider)
	if status != http.StatusCreated {
		t.Fatalf("create provider status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "provider.created", "provider", createdProviderID)
	provider["name"] = fixture.prefix + " Renamed Provider"
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/providers/"+createdProviderID, provider)
	if status != http.StatusOK {
		t.Fatalf("update provider status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "provider.updated", "provider", createdProviderID)

	createdLineID := fixture.prefix + "-created-line"
	line := adminMatrixLinePayload(createdLineID, createdOrganizationID, createdProviderID, createdTechnologyID)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/lines", line)
	if status != http.StatusCreated {
		t.Fatalf("create line status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "line.created", "line", createdLineID)

	createdPointID := fixture.prefix + "-created-point"
	point := map[string]interface{}{"id": createdPointID, "line_id": createdLineID, "location": "Primary room", "is_primary": true, "active": true}
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/monitoring-points", point)
	if status != http.StatusCreated {
		t.Fatalf("create monitoring point status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "monitoring_point.created", "monitoring_point", createdPointID)
	point["location"] = "Updated room"
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/monitoring-points/"+createdPointID, point)
	if status != http.StatusOK {
		t.Fatalf("update monitoring point status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "monitoring_point.updated", "monitoring_point", createdPointID)

	lineUpdate := adminMatrixLinePayload(fixture.lineID, fixture.organizationID, fixture.providerID, createdTechnologyID)
	lineUpdate["role"] = "RESERVE"
	lineUpdate["technology"] = "UPDATED-FIBER"
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/lines/"+fixture.lineID, lineUpdate)
	if status != http.StatusOK {
		t.Fatalf("update line status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "line.updated", "line", fixture.lineID)
	var contextVersions, closedContextVersions int
	if err := db.Pool.QueryRow(context.Background(), `SELECT COUNT(*),COUNT(*) FILTER (WHERE valid_to IS NOT NULL) FROM line_context_versions WHERE line_id=$1`, fixture.lineID).Scan(&contextVersions, &closedContextVersions); err != nil {
		t.Fatalf("read line context history: %v", err)
	}
	if contextVersions < 2 || closedContextVersions < 1 {
		t.Fatalf("line context history = versions %d closed %d, want a preserved closed predecessor", contextVersions, closedContextVersions)
	}

	registeredDeviceID := fixture.prefix + "-registered-device"
	status, body = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/devices/register", map[string]interface{}{"device_id": registeredDeviceID, "monitoring_point_id": fixture.pointID, "agent_version": "task014-agent", "display_name": "Task 014 Device"})
	if status != http.StatusCreated {
		t.Fatalf("register device status = %d, want %d; body=%v", status, http.StatusCreated, body)
	}
	oldDeviceToken := responseString(t, body, "device_token")
	assertAdminAudit(t, db, "device.registered", "device", registeredDeviceID)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPatch, "/api/v1/admin/devices/"+registeredDeviceID, map[string]interface{}{"display_name": "Updated Device"})
	if status != http.StatusOK {
		t.Fatalf("update device display name status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "device.display_name_updated", "device", registeredDeviceID)
	status, body = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/devices/"+registeredDeviceID+"/rotate-token", nil)
	if status != http.StatusOK {
		t.Fatalf("rotate device token status = %d, want %d", status, http.StatusOK)
	}
	newDeviceToken := responseString(t, body, "device_token")
	if _, err := auth.AuthenticateDevice(context.Background(), db, registeredDeviceID, oldDeviceToken); err == nil {
		t.Fatal("old device token remained valid after rotation")
	}
	if _, err := auth.AuthenticateDevice(context.Background(), db, registeredDeviceID, newDeviceToken); err != nil {
		t.Fatalf("new device token was rejected: %v", err)
	}
	assertAdminAudit(t, db, "device.token_rotated", "device", registeredDeviceID)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/devices/"+registeredDeviceID+"/block", nil)
	if status != http.StatusOK {
		t.Fatalf("block device status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "device.blocked", "device", registeredDeviceID)
	if _, err := auth.AuthenticateDevice(context.Background(), db, registeredDeviceID, newDeviceToken); err == nil {
		t.Fatal("blocked device token remained valid")
	}
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/devices/"+registeredDeviceID+"/unblock", nil)
	if status != http.StatusOK {
		t.Fatalf("unblock device status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "device.unblocked", "device", registeredDeviceID)
	if _, err := auth.AuthenticateDevice(context.Background(), db, registeredDeviceID, newDeviceToken); err != nil {
		t.Fatalf("unblocked device token was rejected: %v", err)
	}

	createdUserID := fixture.prefix + "-created-user"
	createdUser := map[string]interface{}{"id": createdUserID, "username": fixture.prefix + "-created-user", "role": "DISTRICT", "password": "task014-password", "scopes": []map[string]string{{"scope_type": "DISTRICT", "scope_id": fixture.districtID}}}
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/users", createdUser)
	if status != http.StatusCreated {
		t.Fatalf("create user status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "user.created", "user", createdUserID)
	updatedUser := map[string]interface{}{"id": createdUserID, "username": fixture.prefix + "-created-user", "role": "PROVIDER", "scopes": []map[string]string{{"scope_type": "PROVIDER", "scope_id": fixture.providerID2}}}
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/users/"+createdUserID, updatedUser)
	if status != http.StatusOK {
		t.Fatalf("update user role and scope status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "user.updated", "user", createdUserID)
	assertAdminAudit(t, db, "user.role_changed", "user", createdUserID)
	assertAdminAudit(t, db, "user.scope_changed", "user", createdUserID)
	assertLatestAuditDoesNotContain(t, db, "user.updated", "user", createdUserID, "task014-password")

	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/schedules", map[string]interface{}{"tests_per_day": 5, "jitter_minutes": 15, "light_checks_between": true})
	if status != http.StatusOK {
		t.Fatalf("update schedule status = %d, want %d", status, http.StatusOK)
	}
	assertAdminAudit(t, db, "schedule.updated", "agent_schedule", "1")

	policyFrom := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Second)
	policyFirst := adminMatrixPolicyPayload(fixture.lineID, policyFrom, 2, 4)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/policies", policyFirst)
	if status != http.StatusCreated {
		t.Fatalf("create first policy version status = %d, want %d", status, http.StatusCreated)
	}
	var firstPolicyID int64
	if err := db.Pool.QueryRow(context.Background(), `SELECT id FROM threshold_policy_versions WHERE scope_type='LINE' AND scope_id=$1 AND valid_from=$2`, fixture.lineID, policyFrom).Scan(&firstPolicyID); err != nil {
		t.Fatalf("find first policy version: %v", err)
	}
	var firstConfirmCount, firstRecoveryCount int
	if err := db.Pool.QueryRow(context.Background(), `SELECT confirm_count,recovery_count FROM threshold_policy_versions WHERE id=$1`, firstPolicyID).Scan(&firstConfirmCount, &firstRecoveryCount); err != nil {
		t.Fatalf("read first policy confirmation rules: %v", err)
	}
	if firstConfirmCount != 2 || firstRecoveryCount != 4 {
		t.Fatalf("first policy confirmation rules = %d/%d, want 2/4", firstConfirmCount, firstRecoveryCount)
	}
	assertAdminAudit(t, db, "policy.version_created", "threshold_policy", fmt.Sprint(firstPolicyID))

	policySecondFrom := policyFrom.Add(time.Hour)
	policySecond := adminMatrixPolicyPayload(fixture.lineID, policySecondFrom, 3, 5)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/policies", policySecond)
	if status != http.StatusCreated {
		t.Fatalf("create second policy version status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "policy.version_closed", "threshold_policy", fmt.Sprint(firstPolicyID))
	var policyCount, closedPolicyCount int
	if err := db.Pool.QueryRow(context.Background(), `SELECT COUNT(*),COUNT(*) FILTER (WHERE valid_to IS NOT NULL) FROM threshold_policy_versions WHERE scope_id=$1`, fixture.lineID).Scan(&policyCount, &closedPolicyCount); err != nil {
		t.Fatalf("read policy history: %v", err)
	}
	if policyCount != 2 || closedPolicyCount != 1 {
		t.Fatalf("policy history = versions %d closed %d, want 2 and 1", policyCount, closedPolicyCount)
	}
	status, body = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/policies", adminMatrixPolicyPayload(fixture.lineID, policyFrom.Add(30*time.Minute), 4, 6))
	assertAdminError(t, status, body, http.StatusConflict, "policy effective interval overlaps an existing version")

	contractFrom := time.Now().UTC().Add(5 * time.Hour).Truncate(time.Second)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/contracts", adminMatrixContractPayload(fixture.lineID, contractFrom, "C-1"))
	if status != http.StatusCreated {
		t.Fatalf("create first contract version status = %d, want %d", status, http.StatusCreated)
	}
	var firstContractID int64
	if err := db.Pool.QueryRow(context.Background(), `SELECT id FROM contract_versions WHERE line_id=$1 AND valid_from=$2`, fixture.lineID, contractFrom).Scan(&firstContractID); err != nil {
		t.Fatalf("find first contract version: %v", err)
	}
	assertAdminAudit(t, db, "contract.version_created", "contract_version", fmt.Sprint(firstContractID))
	contractSecondFrom := contractFrom.Add(time.Hour)
	status, _ = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/contracts", adminMatrixContractPayload(fixture.lineID, contractSecondFrom, "C-2"))
	if status != http.StatusCreated {
		t.Fatalf("create second contract version status = %d, want %d", status, http.StatusCreated)
	}
	assertAdminAudit(t, db, "contract.version_closed", "contract_version", fmt.Sprint(firstContractID))
	var contractCount, closedContractCount int
	if err := db.Pool.QueryRow(context.Background(), `SELECT COUNT(*),COUNT(*) FILTER (WHERE valid_to IS NOT NULL) FROM contract_versions WHERE line_id=$1`, fixture.lineID).Scan(&contractCount, &closedContractCount); err != nil {
		t.Fatalf("read contract history: %v", err)
	}
	if contractCount != 2 || closedContractCount != 1 {
		t.Fatalf("contract history = versions %d closed %d, want 2 and 1", contractCount, closedContractCount)
	}
	status, body = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPost, "/api/v1/admin/contracts", adminMatrixContractPayload(fixture.lineID, contractFrom.Add(30*time.Minute), "C-overlap"))
	assertAdminError(t, status, body, http.StatusConflict, "contract effective interval overlaps an existing version")
	status, body = adminMatrixRequest(t, fixture.server, adminToken, http.MethodPut, "/api/v1/admin/contracts/"+fmt.Sprint(firstContractID), map[string]interface{}{"line_id": fixture.lineID})
	assertAdminError(t, status, body, http.StatusMethodNotAllowed, "method not allowed")

	status, body = adminMatrixRequest(t, fixture.server, fixture.districtToken, http.MethodGet, "/api/v1/agent-versions", nil)
	if status != http.StatusOK {
		t.Fatalf("observed agent versions status = %d, want %d; body=%v", status, http.StatusOK, body)
	}
	items, ok := body["items"].([]interface{})
	if !ok || len(items) == 0 {
		t.Fatalf("observed agent versions items = %#v, want seeded telemetry", body["items"])
	}
	status, _ = adminMatrixRequest(t, fixture.server, fixture.schoolToken, http.MethodPost, "/api/v1/agent-versions", map[string]interface{}{"version": "forbidden"})
	if status != http.StatusNotFound {
		t.Fatalf("observed agent version mutation status = %d, want read-only 404", status)
	}

	validationCases := []struct {
		name, method, path, want string
		payload                  interface{}
	}{
		{name: "organization", method: http.MethodPost, path: "/api/v1/admin/organizations", payload: map[string]interface{}{}, want: "invalid organization payload"},
		{name: "device registration", method: http.MethodPost, path: "/api/v1/admin/devices/register", payload: map[string]interface{}{}, want: "device_id, monitoring_point_id and display_name are required"},
		{name: "user", method: http.MethodPost, path: "/api/v1/admin/users", payload: map[string]interface{}{}, want: "invalid user payload"},
		{name: "provider", method: http.MethodPost, path: "/api/v1/admin/providers", payload: map[string]interface{}{}, want: "invalid provider payload"},
		{name: "line", method: http.MethodPost, path: "/api/v1/admin/lines", payload: map[string]interface{}{}, want: "invalid line payload"},
		{name: "monitoring point", method: http.MethodPost, path: "/api/v1/admin/monitoring-points", payload: map[string]interface{}{}, want: "invalid monitoring point payload"},
		{name: "schedule", method: http.MethodPut, path: "/api/v1/admin/schedules", payload: map[string]interface{}{"tests_per_day": 2}, want: "tests_per_day must be 3-5 and jitter_minutes 0-240"},
		{name: "policy scope", method: http.MethodPost, path: "/api/v1/admin/policies", payload: map[string]interface{}{"scope_type": "OTHER"}, want: "scope_type must be GLOBAL or LINE"},
		{name: "catalog item", method: http.MethodPost, path: "/api/v1/admin/catalogs/districts", payload: map[string]interface{}{}, want: "id and name are required"},
		{name: "contract", method: http.MethodPost, path: "/api/v1/admin/contracts", payload: map[string]interface{}{"line_id": fixture.lineID}, want: "valid_from is required"},
	}
	for _, tt := range validationCases {
		t.Run("validation/"+tt.name, func(t *testing.T) {
			status, body := adminMatrixRequest(t, fixture.server, adminToken, tt.method, tt.path, tt.payload)
			assertAdminError(t, status, body, http.StatusUnprocessableEntity, tt.want)
		})
	}
}

func openAdminMatrixDB(t *testing.T) *database.DB {
	t.Helper()
	if strings.EqualFold(os.Getenv("LINKWATCH_ENV"), "production") && strings.TrimSpace(os.Getenv("LINKWATCH_TEST_DATABASE_URL")) == "" {
		t.Skip("admin matrix integration test requires LINKWATCH_TEST_DATABASE_URL outside production")
	}
	dsn := strings.TrimSpace(os.Getenv("LINKWATCH_TEST_DATABASE_URL"))
	if dsn == "" {
		dsn = database.DefaultDSN()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	db, err := database.Open(ctx, dsn)
	if err != nil {
		t.Skipf("admin matrix integration test requires PostgreSQL: %v", err)
	}
	return db
}

func createAdminMatrixFixture(t *testing.T, db *database.DB) adminMatrixFixture {
	t.Helper()
	prefix := fmt.Sprintf("task014-admin-%d", time.Now().UnixNano())
	now := time.Now().UTC().Truncate(time.Second)
	fixture := adminMatrixFixture{
		prefix:         prefix,
		db:             db,
		districtID:     prefix + "-district",
		technologyID:   prefix + "-technology",
		technologyID2:  prefix + "-technology-2",
		organizationID: prefix + "-organization",
		providerID:     prefix + "-provider",
		providerID2:    prefix + "-provider-2",
		lineID:         prefix + "-line",
		pointID:        prefix + "-point",
		deviceID:       prefix + "-device",
		scopeUserID:    prefix + "-scope-user",
	}
	exec := func(query string, args ...interface{}) {
		t.Helper()
		if _, err := db.Pool.Exec(context.Background(), query, args...); err != nil {
			t.Fatalf("admin matrix fixture query failed: %v", err)
		}
	}
	exec(`INSERT INTO districts(id,name,active,created_at) VALUES ($1,$2,TRUE,$3)`, fixture.districtID, prefix+" District", now)
	exec(`INSERT INTO technologies(id,name,active,created_at) VALUES ($1,$2,TRUE,$3),($4,$5,TRUE,$3)`, fixture.technologyID, prefix+" Technology", now, fixture.technologyID2, prefix+" Technology 2")
	exec(`INSERT INTO organizations(id,school_id,name,district,district_id,created_at) VALUES ($1,$2,$3,$4,$5,$6)`, fixture.organizationID, prefix+" School", prefix+" Organization", fixture.districtID, fixture.districtID, now)
	exec(`INSERT INTO providers(id,name,active,created_at) VALUES ($1,$2,TRUE,$3),($4,$5,TRUE,$3)`, fixture.providerID, prefix+" Provider", now, fixture.providerID2, prefix+" Provider 2")
	exec(`INSERT INTO lines(id,organization_id,provider_id,role,technology,technology_id,status,created_at) VALUES ($1,$2,$3,'PRIMARY','FIBER',$4,'ACTIVE',$5)`, fixture.lineID, fixture.organizationID, fixture.providerID, fixture.technologyID, now)
	exec(`INSERT INTO monitoring_points(id,line_id,location,is_primary,active,created_at) VALUES ($1,$2,'Primary room',TRUE,TRUE,$3)`, fixture.pointID, fixture.lineID, now)
	legacyDeviceToken := prefix + "-legacy-device-token"
	exec(`INSERT INTO devices(id,monitoring_point_id,auth_token_hash,agent_version,created_at,agent_telemetry_received_at) VALUES ($1,$2,$3,$4,$5,$5)`, fixture.deviceID, fixture.pointID, auth.TokenHash(legacyDeviceToken), "task014-observed-agent", now)
	exec(`INSERT INTO line_context_versions(line_id,provider_id,technology,technology_id,role,valid_from,version,reason,changed_by,created_at) VALUES ($1,$2,'FIBER',$3,'PRIMARY',$4,1,'admin matrix fixture','task014-fixture',$4)`, fixture.lineID, fixture.providerID, fixture.technologyID, now.Add(-time.Minute))

	adminUserID := prefix + "-admin-user"
	districtUserID := prefix + "-district-user"
	schoolUserID := prefix + "-school-user"
	exec(`INSERT INTO users(id,username,role,token_hash,created_at) VALUES ($1,$2,'ADMIN',$3,$4),($5,$6,'DISTRICT',$7,$4),($8,$9,'SCHOOL',$10,$4)`, adminUserID, adminUserID, auth.TokenHash(prefix+"-admin-legacy"), now, districtUserID, districtUserID, auth.TokenHash(prefix+"-district-legacy"), schoolUserID, schoolUserID, auth.TokenHash(prefix+"-school-legacy"))
	exec(`INSERT INTO role_scopes(user_id,scope_type,scope_id) VALUES ($1,'DISTRICT',$2)`, districtUserID, fixture.districtID)

	issue := func(userID string) string {
		t.Helper()
		token, _, err := auth.IssueSession(context.Background(), db, userID, time.Hour, "127.0.0.1", "TASK-014 matrix")
		if err != nil {
			t.Fatalf("issue TASK-014 session: %v", err)
		}
		return token
	}
	fixture.adminToken = issue(adminUserID)
	fixture.districtToken = issue(districtUserID)
	fixture.schoolToken = issue(schoolUserID)

	t.Cleanup(func() { cleanupAdminMatrixFixture(t, db, prefix) })
	server, err := New(db, "")
	if err != nil {
		t.Fatalf("create TASK-014 API server: %v", err)
	}
	fixture.server = server
	return fixture
}

func cleanupAdminMatrixFixture(t *testing.T, db *database.DB, prefix string) {
	t.Helper()
	pattern := prefix + "%"
	queries := []string{
		`DELETE FROM audit_events WHERE actor_id LIKE $1 OR object_id LIKE $1 OR object_id IN (SELECT id::text FROM contract_versions WHERE line_id LIKE $1) OR object_id IN (SELECT id::text FROM threshold_policy_versions WHERE scope_id LIKE $1)`,
		`DELETE FROM auth_sessions WHERE user_id LIKE $1`,
		`DELETE FROM role_scopes WHERE user_id LIKE $1`,
		`DELETE FROM devices WHERE id LIKE $1`,
		`DELETE FROM monitoring_points WHERE id LIKE $1`,
		`DELETE FROM line_context_versions WHERE line_id LIKE $1`,
		`DELETE FROM threshold_policy_versions WHERE scope_id LIKE $1`,
		`DELETE FROM contract_versions WHERE line_id LIKE $1`,
		`DELETE FROM lines WHERE id LIKE $1`,
		`DELETE FROM providers WHERE id LIKE $1`,
		`DELETE FROM organizations WHERE id LIKE $1`,
		`DELETE FROM users WHERE id LIKE $1`,
		`DELETE FROM districts WHERE id LIKE $1`,
		`DELETE FROM technologies WHERE id LIKE $1`,
	}
	for _, query := range queries {
		if _, err := db.Pool.Exec(context.Background(), query, pattern); err != nil {
			t.Errorf("TASK-014 fixture cleanup failed: %v", err)
		}
	}
}

func adminMatrixRequest(t *testing.T, server *Server, token, method, path string, payload interface{}) (int, map[string]interface{}) {
	t.Helper()
	var raw []byte
	if payload != nil {
		var err error
		raw, err = json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal TASK-014 request: %v", err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(raw))
	request.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	if recorder.Body.Len() == 0 {
		return recorder.Code, nil
	}
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode TASK-014 response HTTP %d: %v; body=%q", recorder.Code, err, recorder.Body.String())
	}
	return recorder.Code, body
}

func adminMatrixOrganizationPayload(id, districtID string) map[string]interface{} {
	return map[string]interface{}{
		"id": id, "school_id": id + "-school", "name": "Created Organization", "district": districtID, "district_id": districtID,
		"address": "Address", "contact_name": "Operator", "contact_phone": "+70000000000", "contact_role": "Director", "contact_email": "operator@example.test", "active": true,
	}
}

func adminMatrixLinePayload(id, organizationID, providerID, technologyID string) map[string]interface{} {
	return map[string]interface{}{"id": id, "organization_id": organizationID, "provider_id": providerID, "role": "RESERVE", "technology": "FIBER", "technology_id": technologyID, "status": "ACTIVE"}
}

func adminMatrixPolicyPayload(lineID string, validFrom time.Time, confirmCount, recoveryCount int) map[string]interface{} {
	return map[string]interface{}{"scope_type": "LINE", "scope_id": lineID, "valid_from": validFrom, "download_min": 20, "upload_min": 20, "ping_max": 100, "jitter_max": 30, "packet_loss_max": 2, "availability_min": 99, "confirm_count": confirmCount, "recovery_count": recoveryCount, "freshness_seconds": 86400}
}

func adminMatrixContractPayload(lineID string, validFrom time.Time, contractNo string) map[string]interface{} {
	return map[string]interface{}{"line_id": lineID, "valid_from": validFrom, "contract_no": contractNo, "download_min": 20, "upload_min": 20, "ping_max": 100, "jitter_max": 30, "packet_loss_max": 2, "availability_min": 99}
}

func assertAdminError(t *testing.T, status int, body map[string]interface{}, wantStatus int, wantMessage string) {
	t.Helper()
	if status != wantStatus {
		t.Fatalf("status = %d, want %d; body=%v", status, wantStatus, body)
	}
	if body == nil || body["error"] != wantMessage {
		t.Fatalf("error = %#v, want %q; body=%v", body["error"], wantMessage, body)
	}
}

func responseString(t *testing.T, body map[string]interface{}, key string) string {
	t.Helper()
	value, ok := body[key].(string)
	if !ok || strings.TrimSpace(value) == "" {
		t.Fatalf("response field %q = %#v, want non-empty string", key, body[key])
	}
	return value
}

func assertAdminAudit(t *testing.T, db *database.DB, action, objectType, objectID string) {
	t.Helper()
	var count int
	if err := db.Pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM audit_events WHERE action=$1 AND object_type=$2 AND object_id=$3`, action, objectType, objectID).Scan(&count); err != nil {
		t.Fatalf("count audit %s/%s/%s: %v", action, objectType, objectID, err)
	}
	if count == 0 {
		t.Fatalf("missing audit event %s/%s/%s", action, objectType, objectID)
	}
}

func assertLatestAuditSnapshotsContain(t *testing.T, db *database.DB, action, objectType, objectID, beforeNeed, afterNeed string) {
	t.Helper()
	var before, after []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT before_json,after_json FROM audit_events WHERE action=$1 AND object_type=$2 AND object_id=$3 ORDER BY id DESC LIMIT 1`, action, objectType, objectID).Scan(&before, &after); err != nil {
		t.Fatalf("read audit snapshots %s/%s/%s: %v", action, objectType, objectID, err)
	}
	if !strings.Contains(string(before), beforeNeed) || !strings.Contains(string(after), afterNeed) {
		t.Fatalf("audit snapshots before=%s after=%s, want %q before and %q after", before, after, beforeNeed, afterNeed)
	}
}

func assertLatestAuditDoesNotContain(t *testing.T, db *database.DB, action, objectType, objectID, forbidden string) {
	t.Helper()
	var before, after []byte
	if err := db.Pool.QueryRow(context.Background(), `SELECT before_json,after_json FROM audit_events WHERE action=$1 AND object_type=$2 AND object_id=$3 ORDER BY id DESC LIMIT 1`, action, objectType, objectID).Scan(&before, &after); err != nil {
		t.Fatalf("read audit snapshots %s/%s/%s: %v", action, objectType, objectID, err)
	}
	if strings.Contains(string(before), forbidden) || strings.Contains(string(after), forbidden) {
		t.Fatalf("audit snapshots leaked forbidden value %q: before=%s after=%s", forbidden, before, after)
	}
}
