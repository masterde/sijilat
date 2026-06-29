// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/cliutil"
	"sijilat-pp-cli/internal/sijilatapi"

	"github.com/spf13/cobra"
)

func newSyncCmd(flags *rootFlags) *cobra.Command {
	var f sijilatapi.SearchFilters
	var maxScanPages, limit int
	var details bool

	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Populate the local mirror by crawling a filtered slice of the registry (use --details to fetch shareholders for graph/controls/diff)",
		Long: strings.Trim(`
Sync builds the local SQLite mirror that powers the offline and analytic
commands (search --local, stats, expiring). Scope it with at least one filter.
Add --details to also fetch each company's full profile, which populates the
shareholder/partner index required by 'graph', 'controls', 'diff', and 'feed'
(slower: one detail call per company).`, "\n"),
		Example: strings.Trim(`
  sijilat sync --name-en trading
  sijilat sync --status ACTIVE --sector IT --max-scan-pages 5
  sijilat sync --name-en "ruyan" --details`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "false"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && cmd.Flags().NFlag() == 0 {
				return cmd.Help()
			}
			if dryRunOK(flags) {
				fmt.Fprintln(cmd.OutOrStdout(), "would sync registry slice into the local mirror")
				return nil
			}
			if !anyFilterSet(f) {
				_ = cmd.Usage()
				return usageErr(fmt.Errorf("scope the sync with at least one filter (e.g. --name-en, --status, --sector)"))
			}

			ctx, cancel := boundCtx(cmd.Context(), flags)
			defer cancel()

			scan := maxScanPages
			if scan <= 0 {
				scan = 10
			}
			maxItems := -1
			if limit > 0 {
				maxItems = limit
			}
			if cliutil.IsDogfoodEnv() {
				scan = 1
				if maxItems < 0 || maxItems > 10 {
					maxItems = 10
				}
				details = false
			}

			client := flags.sijilatClient()
			rows, total, err := client.SearchAll(ctx, f, 50, maxItems, scan, false)
			if err != nil {
				return fmt.Errorf("crawling registry: %w", err)
			}

			st, err := flags.openStore()
			if err != nil {
				return err
			}
			defer st.Close()

			stored := 0
			for _, r := range rows {
				if err := st.UpsertCompany(r); err != nil {
					return fmt.Errorf("storing %s: %w", r.CRNumber, err)
				}
				stored++
			}

			detailed, detailErrs := 0, 0
			if details {
				for _, r := range rows {
					if _, _, _, err := fetchAndStoreDetail(ctx, client, st, r.CRNumber, r.Branch, true); err != nil {
						detailErrs++
						continue
					}
					detailed++
				}
			}

			result := map[string]any{
				"matched_total":  total,
				"synced":         stored,
				"details_synced": detailed,
				"mirror":         flags.storePath(),
			}
			if detailErrs > 0 {
				result["detail_errors"] = detailErrs
				fmt.Fprintf(cmd.ErrOrStderr(), "warning: %d detail fetch(es) failed; people/diff data may be incomplete\n", detailErrs)
			}
			if !details {
				result["note"] = "ran without --details; run with --details to enable graph, controls, diff, and feed"
			}
			return flags.emit(cmd, result)
		},
	}
	fl := cmd.Flags()
	fl.StringVar(&f.NameEN, "name-en", "", "English company name (partial match)")
	fl.StringVar(&f.NameAR, "name-ar", "", "Arabic company name (partial match)")
	fl.StringVar(&f.Status, "status", "", "Status filter: ACTIVE, EXPIRED, CANCELLED (comma-separated)")
	fl.StringVar(&f.Type, "type", "", "Company type code(s)")
	fl.StringVar(&f.Sector, "sector", "", "Economic sector code")
	fl.StringVar(&f.Activity, "activity", "", "ISIC4 activity code(s)")
	fl.StringVar(&f.Nationality, "nationality", "", "Company nationality code")
	fl.StringVar(&f.Municipality, "municipality", "", "Municipality code")
	fl.StringVar(&f.PartnerEN, "partner", "", "Partner/shareholder English name (sync all companies a person is in)")
	fl.StringVar(&f.PartnerCR, "partner-cr", "", "Partner's CR number")
	fl.BoolVar(&details, "details", false, "Also fetch full profiles (shareholders/board) — enables graph, controls, diff, feed")
	fl.IntVar(&maxScanPages, "max-scan-pages", 10, "Maximum result pages to crawl")
	fl.IntVar(&limit, "limit", 0, "Maximum companies to sync (0 = all matches up to --max-scan-pages)")
	return cmd
}
