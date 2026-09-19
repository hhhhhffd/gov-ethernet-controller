package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"linkwatch/server/internal/admin"
	"linkwatch/server/internal/api"
	"linkwatch/server/internal/auth"
	"linkwatch/server/internal/database"
	"linkwatch/server/internal/measurements"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := api.ValidateRuntimeConfig(); err != nil {
		logger.Error("invalid runtime configuration", "error", err)
		os.Exit(1)
	}
	db, err := database.Open(ctx, database.DefaultDSN())
	if err != nil {
		logger.Error("database startup failed", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := bootstrap(ctx, db); err != nil {
		logger.Error("bootstrap failed", "error", err)
		os.Exit(1)
	}
	webDir := os.Getenv("LINKWATCH_WEB_DIR")
	if webDir == "" {
		webDir = findWebDir()
	}
	server, err := api.New(db, webDir)
	if err != nil {
		logger.Error("invalid runtime configuration", "error", err)
		os.Exit(1)
	}
	address := os.Getenv("LINKWATCH_ADDR")
	if address == "" {
		address = ":8080"
	}
	httpServer := &http.Server{Addr: address, Handler: server.Handler(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	go runNotificationOutbox(ctx, server.Measure, logger)
	go runFreshnessWorker(ctx, server.Measure, logger)
	go runSituationWorker(ctx, server, logger)
	go runAgentCommandWorker(ctx, server, logger)
	go func() {
		logger.Info("linkwatch server listening", "addr", address)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server stopped", "error", err)
			stop()
		}
	}()
	<-ctx.Done()
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdown)
}

func runAgentCommandWorker(ctx context.Context, server *api.Server, logger *slog.Logger) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := server.ReconcileAgentCommands(ctx); err != nil && ctx.Err() == nil {
			logger.Warn("agent command reconciliation failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runNotificationOutbox(ctx context.Context, service *measurements.Service, logger *slog.Logger) {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if _, err := service.DispatchPendingNotifications(ctx, 100); err != nil && ctx.Err() == nil {
			logger.Warn("notification outbox dispatch failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func runFreshnessWorker(ctx context.Context, service *measurements.Service, logger *slog.Logger) {
	const interval = 60 * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	refresh := func() {
		refreshed, err := service.RefreshFreshness(ctx, time.Now().UTC())
		if err != nil && ctx.Err() == nil {
			logger.Warn("freshness refresh failed", "refreshed", refreshed, "error", err)
		}
	}
	refresh()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}

func runSituationWorker(ctx context.Context, server *api.Server, logger *slog.Logger) {
	const interval = 30 * time.Second
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	refresh := func() {
		if err := server.RefreshSituations(ctx); err != nil && ctx.Err() == nil {
			logger.Warn("situation refresh failed", "error", err)
		}
	}
	refresh()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}

func bootstrap(ctx context.Context, db *database.DB) error {
	environment := strings.ToLower(os.Getenv("LINKWATCH_ENV"))
	if environment == "production" {
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM users`).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			username, password := os.Getenv("LINKWATCH_BOOTSTRAP_ADMIN_USERNAME"), os.Getenv("LINKWATCH_BOOTSTRAP_ADMIN_PASSWORD")
			if username == "" || len(password) < 12 {
				return errors.New("empty production database requires LINKWATCH_BOOTSTRAP_ADMIN_USERNAME and a 12+ character LINKWATCH_BOOTSTRAP_ADMIN_PASSWORD")
			}
			hash, err := auth.HashPassword(password)
			if err != nil {
				return err
			}
			_, err = db.Pool.Exec(ctx, `INSERT INTO users(id,username,role,token_hash,password_hash,created_at) VALUES ($1,$2,'ADMIN',$3,$4,now())`, "bootstrap-admin", username, auth.TokenHash(randomBootstrapToken()), hash)
			if err != nil {
				return err
			}
		}
		return nil
	}
	if os.Getenv("LINKWATCH_SEED_DEMO") == "1" || os.Getenv("LINKWATCH_SEED_DEMO") == "true" {
		return admin.SeedDemo(ctx, db)
	}
	return nil
}

func randomBootstrapToken() string {
	return "bootstrap-" + time.Now().UTC().Format("20060102150405.000000000")
}

func findWebDir() string {
	for _, candidate := range []string{"/app/web", "./web", filepath.Join("..", "..", "web")} {
		if _, err := os.Stat(filepath.Join(candidate, "index.html")); err == nil {
			return candidate
		}
	}
	return "./web"
}
