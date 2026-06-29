// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/sijilatapi"

	"github.com/spf13/cobra"
)

func newLookupsCmd(flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "lookups [table]",
		Short: "List the registry filter code tables (status, type, nationality, sector, municipality)",
		Long: strings.Trim(`
The registry's search filters expect numeric codes. The search command accepts
friendly names and resolves them automatically, but this command lists the
underlying code tables so you can see valid values (e.g. status ACTIVE = 3103).
Pass a table name to show just one: status, type, nationality, sector, or
municipality.`, "\n"),
		Example: strings.Trim(`
  sijilat lookups status --json
  sijilat lookups --json
  sijilat lookups nationality`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if dryRunOK(flags) {
				return nil
			}
			ctx, cancel := boundCtx(cmd.Context(), flags)
			defer cancel()
			lt, err := flags.sijilatClient().Lookups(ctx)
			if err != nil {
				return fmt.Errorf("fetching lookups: %w", err)
			}
			tables := map[string][]sijilatapi.CodeName{
				"status":       lt.Status,
				"type":         lt.Types,
				"nationality":  lt.Nationalities,
				"sector":       lt.Sectors,
				"municipality": lt.Municipalities,
			}
			if len(args) > 0 {
				key := strings.ToLower(args[0])
				if key == "types" {
					key = "type"
				}
				tbl, ok := tables[key]
				if !ok {
					_ = cmd.Usage()
					return usageErr(fmt.Errorf("unknown table %q (use status, type, nationality, sector, or municipality)", args[0]))
				}
				return flags.emit(cmd, map[string]any{"table": key, "count": len(tbl), "values": tbl})
			}
			return flags.emit(cmd, lt)
		},
	}
	return cmd
}
