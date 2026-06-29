// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"

	"sijilat-pp-cli/internal/store"

	"github.com/spf13/cobra"
)

func newWatchCmd(flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:         "watch",
		Short:       "Track companies for change-detection (powers 'feed' and 'expiring --watchlist')",
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return cmd.Help()
		},
	}
	cmd.AddCommand(newWatchAddCmd(flags))
	cmd.AddCommand(newWatchListCmd(flags))
	cmd.AddCommand(newWatchRemoveCmd(flags))
	return cmd
}

func newWatchAddCmd(flags *rootFlags) *cobra.Command {
	var branch string
	cmd := &cobra.Command{
		Use:         "add [cr-number]",
		Short:       "Add a company to the watchlist and capture a baseline snapshot",
		Example:     "  sijilat watch add 21 --branch 10",
		Annotations: map[string]string{"mcp:read-only": "false"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && cmd.Flags().NFlag() == 0 {
				return cmd.Help()
			}
			if dryRunOK(flags) {
				fmt.Fprintln(cmd.OutOrStdout(), "would add company to watchlist")
				return nil
			}
			if len(args) == 0 {
				_ = cmd.Usage()
				return usageErr(fmt.Errorf("a CR number is required, e.g. 'sijilat watch add 21 --branch 10'"))
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
			// Capture a baseline snapshot so the first 'feed'/'diff' has something
			// to compare against.
			if _, _, _, derr := fetchAndStoreDetail(ctx, flags.sijilatClient(), st, cr, branch, true); derr != nil {
				return fmt.Errorf("capturing baseline for %s/%s: %w", cr, branch, derr)
			}
			if err := st.AddWatch(cr, branch); err != nil {
				return err
			}
			return flags.emit(cmd, map[string]any{"watched": true, "cr_number": cr, "branch": branch, "baseline": "captured"})
		},
	}
	cmd.Flags().StringVar(&branch, "branch", "", "Branch number (head office = 1)")
	return cmd
}

func newWatchListCmd(flags *rootFlags) *cobra.Command {
	return &cobra.Command{
		Use:         "list",
		Short:       "List watched companies (CR number and branch) from the local watchlist",
		Example:     "  sijilat watch list --json",
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if dryRunOK(flags) {
				return nil
			}
			st, missing, err := flags.openStoreRead(cmd, "sijilat watch add <cr>")
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror("sijilat watch add <cr>", map[string]any{"watchlist": []store.WatchEntry{}}))
			}
			defer st.Close()
			entries, err := st.ListWatch()
			if err != nil {
				return err
			}
			return flags.emit(cmd, map[string]any{"count": len(entries), "watchlist": entries})
		},
	}
}

func newWatchRemoveCmd(flags *rootFlags) *cobra.Command {
	var branch string
	cmd := &cobra.Command{
		Use:     "rm [cr-number]",
		Short:   "Remove a company from the watchlist",
		Example: "  sijilat watch rm 21 --branch 10",
		// Removing a non-watched CR is an idempotent no-op (removed:false), not
		// an error — skip the error-path probe.
		Annotations: map[string]string{"mcp:read-only": "false", "pp:no-error-path-probe": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && cmd.Flags().NFlag() == 0 {
				return cmd.Help()
			}
			if dryRunOK(flags) {
				return nil
			}
			if len(args) == 0 {
				_ = cmd.Usage()
				return usageErr(fmt.Errorf("a CR number is required"))
			}
			cr := args[0]
			if branch == "" {
				branch = "1"
			}
			st, missing, err := flags.openStoreRead(cmd, "sijilat watch add <cr>")
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror("sijilat watch add <cr>", map[string]any{"removed": false, "cr_number": cr, "branch": branch}))
			}
			defer st.Close()
			removed, err := st.RemoveWatch(cr, branch)
			if err != nil {
				return err
			}
			return flags.emit(cmd, map[string]any{"removed": removed, "cr_number": cr, "branch": branch})
		},
	}
	cmd.Flags().StringVar(&branch, "branch", "", "Branch number (head office = 1)")
	return cmd
}
