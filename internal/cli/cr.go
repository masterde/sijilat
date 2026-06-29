// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"github.com/spf13/cobra"
)

// newCrCmd is the spec-aligned resource group mirroring the upstream
// CRdetails endpoints. Its subcommands share their implementation with the
// friendlier top-level `search` and `company` commands.
func newCrCmd(flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:         "cr",
		Short:       "Commercial registrations (companies) in Bahrain's Sijilat registry",
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	cmd.AddCommand(newCrSearchCmd(flags))
	cmd.AddCommand(newCrDetailCmd(flags))
	return cmd
}

func newCrSearchCmd(flags *rootFlags) *cobra.Command {
	s := &searchFlags{}
	cmd := &cobra.Command{
		Use:         "search",
		Short:       "Search commercial registrations (POST CRdetails/AdvanceSearchCR_Paging)",
		Example:     "  sijilat cr search --name-en trading --status ACTIVE --json",
		Annotations: map[string]string{"pp:endpoint": "cr.search", "pp:method": "POST", "pp:path": "CRdetails/AdvanceSearchCR_Paging", "mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRegistrySearch(cmd, flags, s, args)
		},
	}
	registerSearchFlags(cmd, s)
	return cmd
}

func newCrDetailCmd(flags *rootFlags) *cobra.Command {
	var branch string
	var raw bool
	cmd := &cobra.Command{
		Use:         "detail [cr-number]",
		Short:       "Full company profile (POST CRdetails/CompleteCRDetails)",
		Example:     "  sijilat cr detail 21 --branch 10 --json",
		Annotations: map[string]string{"pp:endpoint": "cr.detail", "pp:method": "POST", "pp:path": "CRdetails/CompleteCRDetails", "mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCompanyDetail(cmd, flags, args, branch, raw)
		},
	}
	cmd.Flags().StringVar(&branch, "branch", "", "Branch number (head office = 1)")
	cmd.Flags().BoolVar(&raw, "raw", false, "Emit the upstream response unchanged")
	return cmd
}
