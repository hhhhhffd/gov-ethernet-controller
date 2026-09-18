package database

import (
	"context"
	"embed"
	"fmt"
	"os"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

const latestMigrationVersion = 23

var migrations = []struct {
	version int64
	file    string
}{
	{version: 1, file: "migrations/001_initial.sql"},
	{version: 2, file: "migrations/002_runtime_hardening.sql"},
	{version: 3, file: "migrations/003_provider_delivery_retry.sql"},
	{version: 4, file: "migrations/004_schema_invariants.sql"},
	{version: 5, file: "migrations/005_policy_scope_integrity.sql"},
	{version: 6, file: "migrations/006_situation_integrity.sql"},
	{version: 7, file: "migrations/007_agent_telemetry.sql"},
	{version: 8, file: "migrations/008_agent_boot_order.sql"},
	{version: 9, file: "migrations/009_device_hostname.sql"},
	{version: 10, file: "migrations/010_admin_catalog_auth.sql"},
	{version: 11, file: "migrations/011_p0_passport_fields.sql"},
	{version: 12, file: "migrations/012_provider_case_draft_generations.sql"},
	{version: 13, file: "migrations/013_provider_case_line_context.sql"},
	{version: 14, file: "migrations/014_t016_query_indexes.sql"},
	{version: 15, file: "migrations/015_line_context_versions.sql"},
	{version: 16, file: "migrations/016_measurement_verifications.sql"},
	{version: 17, file: "migrations/017_line_context_snapshot_backfill.sql"},
	{version: 18, file: "migrations/018_notification_channels.sql"},
	{version: 19, file: "migrations/019_agent_commands.sql"},
	{version: 20, file: "migrations/020_situation_lifecycle.sql"},
	{version: 21, file: "migrations/021_live_verify.sql"},
	{version: 22, file: "migrations/022_remote_agent_config.sql"},
	{version: 23, file: "migrations/023_agent_updates.sql"},
}

// DB is the only persistence dependency used by the server.  Keeping the pool
// behind this small type makes readiness and migration behaviour explicit and
// prevents handlers from growing ad-hoc connection management.
type DB struct {
	Pool *pgxpool.Pool
}

func DefaultDSN() string {
	if value := os.Getenv("LINKWATCH_DATABASE_URL"); value != "" {
		return value
	}
	if value := os.Getenv("DATABASE_URL"); value != "" {
		return value
	}
	return "postgres://linkwatch:linkwatch@localhost:5432/linkwatch?sslmode=disable"
}

func Open(ctx context.Context, dsn string) (*DB, error) {
	if dsn == "" {
		dsn = DefaultDSN()
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse postgres config: %w", err)
	}
	if max := os.Getenv("LINKWATCH_DB_MAX_CONNS"); max != "" {
		var parsed int
		if _, err := fmt.Sscanf(max, "%d", &parsed); err != nil || parsed < 1 {
			return nil, fmt.Errorf("LINKWATCH_DB_MAX_CONNS must be a positive integer")
		}
		cfg.MaxConns = int32(parsed)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open postgres pool: %w", err)
	}
	db := &DB{Pool: pool}
	pingCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := db.Pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	if err := db.Migrate(pingCtx); err != nil {
		pool.Close()
		return nil, err
	}
	return db, nil
}

func (db *DB) Close() { db.Pool.Close() }

func (db *DB) Ready(ctx context.Context) error {
	if err := db.Pool.Ping(ctx); err != nil {
		return err
	}
	var one int
	if err := db.Pool.QueryRow(ctx, "SELECT 1").Scan(&one); err != nil {
		return err
	}
	var migrated bool
	if err := db.Pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version >= $1)", latestMigrationVersion).Scan(&migrated); err != nil {
		return err
	}
	if !migrated {
		return fmt.Errorf("required database migration %d is not applied", latestMigrationVersion)
	}
	return nil
}

func (db *DB) Migrate(ctx context.Context) error {
	tx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin migration transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize first-run DDL when several server replicas start together.
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(742031)"); err != nil {
		return fmt.Errorf("migration lock: %w", err)
	}
	for _, migration := range migrations {
		// Migration 001 creates schema_migrations itself, so it is the only
		// script that must be executed before the applied-version lookup is
		// available. All later scripts are skipped once recorded.
		if migration.version != 1 {
			var applied bool
			if err := tx.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version=$1)", migration.version).Scan(&applied); err != nil {
				return fmt.Errorf("check migration %d: %w", migration.version, err)
			}
			if applied {
				continue
			}
		}
		sqlBytes, err := migrationFS.ReadFile(migration.file)
		if err != nil {
			return fmt.Errorf("read migration %d: %w", migration.version, err)
		}
		if _, err := tx.Exec(ctx, string(sqlBytes)); err != nil {
			return fmt.Errorf("apply migration %d: %w", migration.version, err)
		}
		if _, err := tx.Exec(ctx, "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING", migration.version); err != nil {
			return fmt.Errorf("record migration %d: %w", migration.version, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}
	return nil
}
