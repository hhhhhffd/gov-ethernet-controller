package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"linkwatch/server/internal/cleanup"
)

func main() {
	var options cleanup.Options
	var dryRun bool
	flag.StringVar(&options.DatabaseURL, "database-url", "", "PostgreSQL URL; defaults to LINKWATCH_DATABASE_URL, DATABASE_URL, or the repository local default")
	flag.BoolVar(&options.Apply, "apply", false, "apply the identified deletes; requires all confirmation flags")
	flag.BoolVar(&dryRun, "dry-run", false, "report only (the default)")
	flag.StringVar(&options.Environment, "environment", "", "explicit non-production environment confirmation for --apply")
	flag.StringVar(&options.ConfirmTarget, "confirm-target", "", "exact current PostgreSQL database name confirmation for --apply")
	flag.BoolVar(&options.ConfirmApply, "confirm-apply", false, "confirm deletion of synthetic operational rows")
	flag.Parse()

	if dryRun && options.Apply {
		fatal("--dry-run and --apply are mutually exclusive")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, err := cleanup.Run(ctx, options)
	if err != nil {
		fatal(err.Error())
	}

	mode := "DRY-RUN (no persistent mutation)"
	if result.Applied {
		mode = "APPLY (transaction committed)"
	}
	fmt.Printf("LINKWATCH synthetic operational cleanup\nmode: %s\ndatabase: %s\n\n", mode, result.Database)
	fmt.Println("Identification rules:")
	for _, rule := range cleanup.RulesSummary() {
		fmt.Printf("- %s\n", rule)
	}
	fmt.Println("\nProtected categories:")
	for _, category := range cleanup.ProtectedCategories() {
		fmt.Printf("- %s\n", category)
	}
	fmt.Println("\nInventory:")
	fmt.Printf("%-32s %10s %10s  %-52s  %s\n", "table", "total", "targeted", "rule", "dependency/order")
	for _, row := range result.Rows {
		fmt.Printf("%-32s %10d %10d  %-52s  %s\n", row.Table, row.Total, row.Targeted, row.Rule, row.Depends)
	}
	if result.Applied {
		fmt.Println("\nDeleted rows:")
		tables := make([]string, 0, len(result.Deleted))
		for table := range result.Deleted {
			tables = append(tables, table)
		}
		sort.Strings(tables)
		for _, table := range tables {
			count := result.Deleted[table]
			fmt.Printf("- %s: %d\n", table, count)
		}
	}
}

func fatal(message string) {
	if !strings.HasPrefix(message, "cleanup blocked:") {
		message = "cleanup blocked: " + message
	}
	fmt.Fprintln(os.Stderr, message)
	os.Exit(1)
}
