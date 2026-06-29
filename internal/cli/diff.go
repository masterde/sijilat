// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/sijilatapi"

	"github.com/spf13/cobra"
)

// pp:data-source live
func newNovelDiffCmd(flags *rootFlags) *cobra.Command {
	var branch string
	cmd := &cobra.Command{
		Use:   "diff [cr-number]",
		Short: "Detect exactly what changed on a company (shareholders, signatories, capital, status, address) since you last checked.",
		Long: strings.Trim(`
Fetch a company's current profile and compare it field-by-field against the most
recent snapshot in the local mirror (status, expiry, capital, address, and the
shareholder/board set), then record a fresh snapshot. On the first run for a
company there is no prior snapshot, so it captures a baseline and reports no
changes rather than fabricating drift.

Use this command for KYC re-screening and monitoring. For a one-off lookup use
'company'; to watch many companies at once use 'feed'.`, "\n"),
		Example: strings.Trim(`
  sijilat diff 21 --branch 10 --json
  sijilat diff 21`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "false", "pp:typed-exit-codes": "0,10"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && cmd.Flags().NFlag() == 0 {
				return cmd.Help()
			}
			if dryRunOK(flags) {
				fmt.Fprintln(cmd.OutOrStdout(), "would diff company against its last snapshot")
				return nil
			}
			if len(args) == 0 {
				_ = cmd.Usage()
				return usageErr(fmt.Errorf("a CR number is required, e.g. 'sijilat diff 21 --branch 10'"))
			}
			cr := args[0]
			if branch == "" {
				branch = "1"
			}
			ctx, cancel := boundCtx(cmd.Context(), flags)
			defer cancel()

			st, err := flags.openStore()
			if err != nil {
				return err
			}
			defer st.Close()

			_, changes, hadPrior, err := fetchAndStoreDetail(ctx, flags.sijilatClient(), st, cr, branch, true)
			if err != nil {
				return fmt.Errorf("diffing company %s/%s: %w", cr, branch, err)
			}
			if changes == nil {
				changes = []sijilatapi.Change{}
			}
			result := map[string]any{
				"cr_number":    cr,
				"branch":       branch,
				"baseline":     !hadPrior,
				"change_count": len(changes),
				"changes":      changes,
			}
			if !hadPrior {
				result["note"] = "baseline snapshot captured; run diff again later to detect changes"
			}
			if err := flags.emit(cmd, result); err != nil {
				return err
			}
			// Typed exit: 10 signals "changes detected" for agent polling.
			if hadPrior && len(changes) > 0 {
				return &cliError{code: 10, err: fmt.Errorf("%d change(s) detected", len(changes))}
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&branch, "branch", "", "Branch number (head office = 1)")
	return cmd
}
