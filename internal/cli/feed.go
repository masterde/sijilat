// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/sijilatapi"

	"github.com/spf13/cobra"
)

// pp:data-source live
func newNovelFeedCmd(flags *rootFlags) *cobra.Command {
	var since string
	cmd := &cobra.Command{
		Use:   "feed",
		Short: "One agent-pollable stream of every change across all watched companies since the last check.",
		Long: strings.Trim(`
Re-fetch every company on the watchlist, diff each against its most recent
snapshot, record fresh snapshots, and emit one combined change stream. Designed
for scheduled polling: it exits 0 when nothing changed and 10 when at least one
watched company changed, so an agent can branch on the exit code.

Populate the watchlist first with 'sijilat watch add <cr>'.`, "\n"),
		Example: strings.Trim(`
  sijilat feed --json
  sijilat feed --since last-sync --json`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "false", "pp:typed-exit-codes": "0,10"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if dryRunOK(flags) {
				return nil
			}
			if since != "" && since != "last-sync" {
				_ = cmd.Usage()
				return usageErr(fmt.Errorf("--since currently supports only 'last-sync' (compare each watched company to its last snapshot)"))
			}

			st, missing, err := flags.openStoreRead(cmd, "sijilat watch add <cr>")
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror("sijilat watch add <cr>", map[string]any{
					"watched": 0, "with_changes": 0, "changes": []any{},
				}))
			}
			defer st.Close()

			watched, err := st.ListWatch()
			if err != nil {
				return err
			}
			ctx, cancel := boundCtx(cmd.Context(), flags)
			defer cancel()
			client := flags.sijilatClient()

			type feedEntry struct {
				CRNumber string              `json:"cr_number"`
				Branch   string              `json:"branch"`
				NameEN   string              `json:"name_en,omitempty"`
				Changes  []sijilatapi.Change `json:"changes"`
			}
			entries := make([]feedEntry, 0)
			fetchErrs := 0
			changedCount := 0
			for _, w := range watched {
				_, changes, _, err := fetchAndStoreDetail(ctx, client, st, w.CRNumber, w.Branch, true)
				if err != nil {
					fetchErrs++
					continue
				}
				if len(changes) > 0 {
					entries = append(entries, feedEntry{CRNumber: w.CRNumber, Branch: w.Branch, NameEN: w.NameEN, Changes: changes})
					changedCount++
				}
			}

			result := map[string]any{
				"watched":      len(watched),
				"with_changes": changedCount,
				"changes":      entries,
			}
			if fetchErrs > 0 {
				result["fetch_errors"] = fetchErrs
				fmt.Fprintf(cmd.ErrOrStderr(), "warning: %d watched company fetch(es) failed\n", fetchErrs)
			}
			if len(watched) == 0 {
				result["note"] = "watchlist is empty; add companies with 'sijilat watch add <cr>'"
			}
			if err := flags.emit(cmd, result); err != nil {
				return err
			}
			if changedCount > 0 {
				return &cliError{code: 10, err: fmt.Errorf("%d watched company(ies) changed", changedCount)}
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&since, "since", "last-sync", "Comparison baseline (currently only 'last-sync')")
	return cmd
}
