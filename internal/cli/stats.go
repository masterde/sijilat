// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"strings"

	"sijilat-pp-cli/internal/store"

	"github.com/spf13/cobra"
)

// pp:data-source local
func newNovelStatsCmd(flags *rootFlags) *cobra.Command {
	var by string
	cmd := &cobra.Command{
		Use:   "stats",
		Short: "Aggregate the synced corpus by status, type, nationality, sector, or registration year.",
		Long: strings.Trim(`
Group the local mirror by one or more dimensions and count companies in each
bucket — the registry exposes no aggregate/count endpoint, so this is only
possible over synced data. Supported dimensions: status, type, nationality,
sector, year. Pass several comma-separated to --by.

Nationality and sector are only populated for companies synced with --details.`, "\n"),
		Example: strings.Trim(`
  sijilat stats --by status --json
  sijilat stats --by status,type,year --json`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if dryRunOK(flags) {
				return nil
			}
			dims := splitCSV(by)
			if len(dims) == 0 {
				dims = []string{"status"}
			}

			st, missing, err := flags.openStoreRead(cmd, "sijilat sync --status ACTIVE --sector <code>")
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror("sijilat sync --status ACTIVE --sector <code>", map[string]any{
					"total_companies": 0, "dimensions": dims, "breakdown": map[string]any{},
				}))
			}
			defer st.Close()

			total, err := st.CompanyCount()
			if err != nil {
				return err
			}
			breakdown := map[string][]store.StatRow{}
			for _, d := range dims {
				rows, err := st.Stats(d)
				if err != nil {
					_ = cmd.Usage()
					return usageErr(err)
				}
				if rows == nil {
					rows = []store.StatRow{}
				}
				breakdown[d] = rows
			}
			return flags.emit(cmd, map[string]any{
				"total_companies": total,
				"dimensions":      dims,
				"breakdown":       breakdown,
			})
		},
	}
	cmd.Flags().StringVar(&by, "by", "status", "Dimensions to group by (comma-separated): status, type, nationality, sector, year")
	return cmd
}

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
