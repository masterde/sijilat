// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strconv"
	"strings"

	"sijilat-pp-cli/internal/store"

	"github.com/spf13/cobra"
)

// pp:data-source local
func newNovelExpiringCmd(flags *rootFlags) *cobra.Command {
	var within string
	var watchlistOnly bool
	cmd := &cobra.Command{
		Use:   "expiring",
		Short: "List synced companies whose CR expires within a window, flagging any that quietly went EXPIRED or CANCELLED.",
		Long: strings.Trim(`
Scan the local mirror for commercial registrations approaching (or past) their
expiry date, computed locally from the stored expiry field — the registry has no
expiry or renewal endpoint. Use --watchlist to limit the scan to companies added
with 'sijilat watch add'. A company is flagged as lapsed when it is past expiry
or no longer ACTIVE.`, "\n"),
		Example: strings.Trim(`
  sijilat expiring --within 60d --json
  sijilat expiring --within 90d --watchlist --json`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if dryRunOK(flags) {
				return nil
			}
			days, err := parseWindowDays(within)
			if err != nil {
				_ = cmd.Usage()
				return usageErr(err)
			}

			hint := "sijilat sync --status ACTIVE --sector <code>"
			if watchlistOnly {
				hint = "sijilat watch add <cr>"
			}
			st, missing, err := flags.openStoreRead(cmd, hint)
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror(hint, map[string]any{
					"within_days": days, "watchlist": watchlistOnly, "companies": []store.ExpiringRow{},
				}))
			}
			defer st.Close()

			rows, err := st.Expiring(days, watchlistOnly)
			if err != nil {
				return fmt.Errorf("computing expiring companies: %w", err)
			}
			if rows == nil {
				rows = []store.ExpiringRow{}
			}
			return flags.emit(cmd, map[string]any{
				"within_days": days,
				"watchlist":   watchlistOnly,
				"count":       len(rows),
				"companies":   rows,
			})
		},
	}
	cmd.Flags().StringVar(&within, "within", "60d", "Expiry window, e.g. 30d, 90d, or a plain number of days")
	cmd.Flags().BoolVar(&watchlistOnly, "watchlist", false, "Only consider companies on the watchlist")
	return cmd
}

// parseWindowDays accepts "60d", "60", or "8w" and returns days.
func parseWindowDays(s string) (int, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if s == "" {
		return 60, nil
	}
	mult := 1
	switch {
	case strings.HasSuffix(s, "d"):
		s = strings.TrimSuffix(s, "d")
	case strings.HasSuffix(s, "w"):
		s = strings.TrimSuffix(s, "w")
		mult = 7
	}
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("invalid --within window %q (use e.g. 30d, 8w, or 90)", s)
	}
	return n * mult, nil
}
