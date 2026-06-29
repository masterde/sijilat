// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/store"

	"github.com/spf13/cobra"
)

// pp:data-source local
func newNovelControlsCmd(flags *rootFlags) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "controls [name]",
		Short: "List every company a person is a partner, signatory, or director of, with their role and share count.",
		Long: strings.Trim(`
Reverse-lookup a person across the synced registry: the upstream search only
goes company -> people, so this inverted view (person -> all companies, with role
and shares) exists only in the local mirror. Populate it first with
'sijilat sync --details ...' or 'sijilat watch add'.

Matching is a case-insensitive substring on the person's English name.`, "\n"),
		Example: strings.Trim(`
  sijilat controls "AHMED ALI" --json
  sijilat controls ruyan --json --select cr_number,role,shares`, "\n"),
		// An unknown name is a valid empty result (substring lookup over the
		// local mirror), not an error — skip the error-path probe.
		Annotations: map[string]string{"mcp:read-only": "true", "pp:no-error-path-probe": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 && cmd.Flags().NFlag() == 0 {
				return cmd.Help()
			}
			if dryRunOK(flags) {
				return nil
			}
			if len(args) == 0 {
				_ = cmd.Usage()
				return usageErr(fmt.Errorf("a person name is required, e.g. 'sijilat controls \"AHMED ALI\"'"))
			}
			name := strings.Join(args, " ")

			st, missing, err := flags.openStoreRead(cmd, "sijilat sync --details --name-en <term>")
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror("sijilat sync --details --name-en <term>", map[string]any{
					"query": name, "companies": []store.ControlRow{},
				}))
			}
			defer st.Close()

			rows, err := st.Controls(name)
			if err != nil {
				return fmt.Errorf("looking up controls: %w", err)
			}
			if rows == nil {
				rows = []store.ControlRow{}
			}
			result := map[string]any{"query": name, "count": len(rows), "companies": rows}
			if len(rows) == 0 {
				result["note"] = "no matches in the local mirror; run 'sijilat sync --details ...' to index shareholders, directors, and signatories"
			}
			return flags.emit(cmd, result)
		},
	}
	return cmd
}
