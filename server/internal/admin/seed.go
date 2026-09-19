package admin

import (
	"context"
	"fmt"
	"time"

	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
)

var DemoUserTokens = map[string]string{
	"admin": "demo-admin-token", "oblast": "demo-oblast-token", "district": "demo-district-token",
	"provider-a": "demo-provider-a-token", "school-42": "demo-school-42-token",
}

var DemoDeviceTokens = map[string]string{
	"device-42-primary": "demo-device-42-primary-token", "device-42-reserve": "demo-device-42-reserve-token",
	"device-07-primary": "demo-device-07-primary-token", "device-99-primary": "demo-device-99-primary-token",
}

// SeedDemo provisions a deterministic development environment. It is never
// called automatically in production unless LINKWATCH_ALLOW_DEMO_SEED=1.
func SeedDemo(ctx context.Context, db *database.DB) error {
	now := time.Now().UTC().Truncate(time.Second)
	demoContextStart := time.Date(2020, time.January, 1, 0, 0, 0, 0, time.UTC)
	organizations := []struct {
		id, schoolID, name, district, address string
		lat, lon                              float64
	}{
		{"org-42", "school-42", "Школа №42", "Алтай", "ул. Центральная, 42", 50.35, 82.62},
		{"org-07", "school-07", "Коммунальное государственное учреждение «Средняя школа №7» отдела образования по городу Усть-Каменогорску управления образования Восточно-Казахстанской области", "Усть-Каменогорск Г.А.", "Восточно-Казахстанская область,город Усть-Каменогорск,Бульвар Гагарина,8", 49.972508, 82.586298},
		{"org-99", "school-99", "Школа №99", "Алтай", "ул. Школьная, 1", 50.31, 82.59},
	}
	for _, item := range organizations {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO organizations(id,school_id,name,district,address,latitude,longitude,contact_name,contact_phone,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'Контакт школы','+7 700 000 00 00',$8) ON CONFLICT DO NOTHING`, item.id, item.schoolID, item.name, item.district, item.address, item.lat, item.lon, now); err != nil {
			return err
		}
	}
	providers := []struct{ id, name, contact string }{{"provider-a", "Provider A", "support@provider-a.example"}, {"provider-b", "Provider B", "support@provider-b.example"}}
	for _, item := range providers {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO providers(id,name,support_contact,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, item.id, item.name, item.contact, now); err != nil {
			return err
		}
	}
	lines := []struct{ id, org, provider, role, technology string }{
		{"line-42-primary", "org-42", "provider-a", "PRIMARY", "FIBER"}, {"line-42-reserve", "org-42", "provider-b", "RESERVE", "STARLINK"},
		{"line-07-primary", "org-07", "provider-a", "PRIMARY", "FIBER"}, {"line-99-primary", "org-99", "provider-a", "PRIMARY", "LTE"},
	}
	for _, item := range lines {
		// PRIMARY lines are activated only after their monitoring point exists;
		// this keeps every committed seed step within the line invariant.
		if _, err := db.Pool.Exec(ctx, `INSERT INTO lines(id,organization_id,provider_id,role,technology,status,created_at) VALUES ($1,$2,$3,$4,$5,'INACTIVE',$6) ON CONFLICT DO NOTHING`, item.id, item.org, item.provider, item.role, item.technology, now); err != nil {
			return err
		}
	}
	for _, item := range lines {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO line_context_versions(line_id,provider_id,technology,role,valid_from,version,reason,changed_by,created_at)
            SELECT id,provider_id,technology,role,$2,1,'initial demo context','seed',$3
            FROM lines
            WHERE id=$1
              AND NOT EXISTS (SELECT 1 FROM line_context_versions WHERE line_id=$1)`, item.id, demoContextStart, now); err != nil {
			return err
		}
	}
	contracts := map[string][2]float64{"line-42-primary": {100, 100}, "line-42-reserve": {40, 10}, "line-07-primary": {50, 50}, "line-99-primary": {20, 10}}
	for lineID, values := range contracts {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO contract_versions(line_id,valid_from,contract_no,contract_date,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,created_by,created_at)
            SELECT $1,'2020-01-01T00:00:00Z',$2,'2020-01-01T00:00:00Z',$3,$4,100,30,2,99,'seed',$5
            WHERE NOT EXISTS (SELECT 1 FROM contract_versions WHERE line_id=$1)`, lineID, "CONTRACT-"+lineID, values[0], values[1], now); err != nil {
			return err
		}
	}
	points := []struct{ id, line, location string }{{"point-42-primary", "line-42-primary", "серверная, Ethernet"}, {"point-42-reserve", "line-42-reserve", "серверная, резервный шлюз"}, {"point-07-primary", "line-07-primary", "серверная, Ethernet"}, {"point-99-primary", "line-99-primary", "кабинет связи, Ethernet"}}
	for _, item := range points {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO monitoring_points(id,line_id,location,is_primary,created_at) VALUES ($1,$2,$3,TRUE,$4) ON CONFLICT DO NOTHING`, item.id, item.line, item.location, now); err != nil {
			return err
		}
	}
	for _, item := range lines {
		if _, err := db.Pool.Exec(ctx, `UPDATE lines SET status='ACTIVE' WHERE id=$1`, item.id); err != nil {
			return err
		}
	}
	for deviceID, token := range DemoDeviceTokens {
		pointID := map[string]string{"device-42-primary": "point-42-primary", "device-42-reserve": "point-42-reserve", "device-07-primary": "point-07-primary", "device-99-primary": "point-99-primary"}[deviceID]
		if _, err := db.Pool.Exec(ctx, `INSERT INTO devices(id,monitoring_point_id,auth_token_hash,agent_version,created_at) VALUES ($1,$2,$3,'0.1.0',$4) ON CONFLICT DO NOTHING`, deviceID, pointID, auth.TokenHash(token), now); err != nil {
			return err
		}
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO threshold_policy_versions(scope_type,scope_id,valid_from,version,download_min,upload_min,ping_max,jitter_max,packet_loss_max,availability_min,confirm_count,confirm_minutes,recovery_count,recovery_minutes,freshness_seconds,created_by,created_at)
        SELECT 'GLOBAL',NULL,'2020-01-01T00:00:00Z',1,20,20,100,30,2,99,3,0,3,0,86400,'seed',$1
        WHERE NOT EXISTS (SELECT 1 FROM threshold_policy_versions WHERE scope_type='GLOBAL' AND version=1)`, now); err != nil {
		return err
	}
	passwordHash, err := auth.HashPassword("demo")
	if err != nil {
		return err
	}
	users := []struct{ id, username, role string }{{"user-admin", "admin", "ADMIN"}, {"user-oblast", "oblast", "OBLAST"}, {"user-district", "district", "DISTRICT"}, {"user-provider-a", "provider-a", "PROVIDER"}, {"user-school-42", "school-42", "SCHOOL"}}
	for _, item := range users {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO users(id,username,role,token_hash,password_hash,created_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, item.id, item.username, item.role, auth.TokenHash(DemoUserTokens[item.username]), passwordHash, now); err != nil {
			return err
		}
	}
	scopes := []struct{ user, typ, id string }{{"user-district", "DISTRICT", "Алтай"}, {"user-provider-a", "PROVIDER", "provider-a"}, {"user-school-42", "ORGANIZATION", "org-42"}}
	for _, item := range scopes {
		if _, err := db.Pool.Exec(ctx, `INSERT INTO role_scopes(user_id,scope_type,scope_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, item.user, item.typ, item.id); err != nil {
			return err
		}
	}
	return nil
}

func ResetDemo(ctx context.Context, db *database.DB) error {
	// Draft generation metadata has a restrictive FK to provider_cases, so it
	// must be cleared before the demo cases themselves.
	for _, table := range []string{"audit_events", "notifications", "situation_members", "situations", "provider_case_draft_generations", "provider_cases", "incident_events", "incidents", "line_state_events", "line_states", "measurement_evaluations", "measurements", "role_scopes", "auth_sessions", "users", "devices", "monitoring_points", "threshold_policy_versions", "contract_versions", "line_context_versions", "lines", "providers", "organizations"} {
		if _, err := db.Pool.Exec(ctx, "DELETE FROM "+table); err != nil {
			return fmt.Errorf("clear %s: %w", table, err)
		}
	}
	return SeedDemo(ctx, db)
}
