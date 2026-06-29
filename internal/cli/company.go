// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"encoding/json"
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/sijilatapi"

	"github.com/spf13/cobra"
)

func newCompanyCmd(flags *rootFlags) *cobra.Command {
	var branch string
	var raw bool

	cmd := &cobra.Command{
		Use:   "company [cr-number]",
		Short: "Full company profile: capital, shareholders, board, signatories, address, activities, amendment history, and branches",
		Long: strings.Trim(`
Fetch the complete profile for a commercial registration. A CR can have several
branches (head office is branch 1); pass --branch to pick one. Use --raw to emit
the upstream response unchanged.`, "\n"),
		Example: strings.Trim(`
  sijilat company 21 --branch 10
  sijilat company 21 --branch 10 --json --select name_en,status,capital,people
  sijilat company 21 --branch 10 --raw`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompanyDetail(cmd, flags, args, branch, raw)
		},
	}
	cmd.Flags().StringVar(&branch, "branch", "", "Branch number (head office = 1)")
	cmd.Flags().BoolVar(&raw, "raw", false, "Emit the upstream response unchanged")
	return cmd
}

// runCompanyDetail is shared by the top-level `company` command and the
// spec-aligned `cr detail` command.
func runCompanyDetail(cmd *cobra.Command, flags *rootFlags, args []string, branch string, raw bool) error {
	if len(args) == 0 && cmd.Flags().NFlag() == 0 {
		return cmd.Help()
	}
	if dryRunOK(flags) {
		fmt.Fprintln(cmd.OutOrStdout(), "would fetch company detail")
		return nil
	}
	if len(args) == 0 {
		_ = cmd.Usage()
		return usageErr(fmt.Errorf("a CR number is required, e.g. 'sijilat company 21 --branch 10'"))
	}
	cr := args[0]
	if branch == "" {
		branch = "1"
	}
	ctx, cancel := boundCtx(cmd.Context(), flags)
	defer cancel()

	data, err := flags.sijilatClient().Detail(ctx, cr, branch)
	if err != nil {
		return fmt.Errorf("fetching company %s/%s: %w", cr, branch, err)
	}
	if raw {
		return flags.emit(cmd, json.RawMessage(data))
	}
	d, err := sijilatapi.ParseDetail(data)
	if err != nil {
		return fmt.Errorf("parsing company detail: %w", err)
	}
	return flags.emit(cmd, d)
}
