// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/store"

	"github.com/spf13/cobra"
)

// pp:data-source local
func newNovelGraphCmd(flags *rootFlags) *cobra.Command {
	var depth int
	var branch string
	cmd := &cobra.Command{
		Use:   "graph [cr-number]",
		Short: "Traverse the partner -> company -> partner network around a CR to surface direct and indirect links.",
		Long: strings.Trim(`
Starting from a company in the local mirror, find other companies that share at
least one shareholder, director, or signatory, then optionally expand outward by
--depth hops. This cross-company ownership traversal is impossible against the
upstream (which only returns one company at a time); it requires the local
shareholder index built by 'sijilat sync --details ...' or 'sijilat watch add'.

For a single company's own people use 'company'; to reverse-lookup one person use
'controls'.`, "\n"),
		Example: strings.Trim(`
  sijilat graph 21 --branch 10 --depth 1 --json
  sijilat graph 21 --depth 2 --json --select to_cr,to_name_en,via_person`, "\n"),
		// An unknown/unsynced seed is a valid empty graph (no linked companies
		// in the local mirror), not an error — skip the error-path probe.
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
				return usageErr(fmt.Errorf("a CR number is required, e.g. 'sijilat graph 21'"))
			}
			seed := args[0]
			if branch == "" {
				branch = "1"
			}
			if depth < 1 {
				depth = 1
			}

			st, missing, err := flags.openStoreRead(cmd, "sijilat sync --details --name-en <term>")
			if err != nil {
				return err
			}
			if missing {
				return flags.emit(cmd, noMirror("sijilat sync --details --name-en <term>", map[string]any{
					"seed_cr": seed, "depth": depth, "related": []store.GraphEdge{}, "related_count": 0,
				}))
			}
			defer st.Close()

			// Breadth-first expansion over shared people, capped by --depth.
			visited := map[string]bool{seed: true}
			frontier := []frontierNode{{cr: seed, branch: branch}}
			var edges []store.GraphEdge
			for hop := 0; hop < depth && len(frontier) > 0; hop++ {
				var next []frontierNode
				for _, node := range frontier {
					people, err := st.PeopleOf(node.cr, node.branch)
					if err != nil {
						return fmt.Errorf("reading people for %s: %w", node.cr, err)
					}
					related, err := st.RelatedCompanies(node.cr, people)
					if err != nil {
						return fmt.Errorf("expanding %s: %w", node.cr, err)
					}
					for _, e := range related {
						edges = append(edges, e)
						if !visited[e.ToCR] {
							visited[e.ToCR] = true
							next = append(next, frontierNode{cr: e.ToCR, branch: e.ToBranch})
						}
					}
				}
				frontier = next
			}
			if edges == nil {
				edges = []store.GraphEdge{}
			}
			result := map[string]any{
				"seed_cr":       seed,
				"depth":         depth,
				"related_count": len(edges),
				"related":       edges,
			}
			if len(edges) == 0 {
				result["note"] = "no linked companies in the local mirror; ensure the seed and its peers were synced with --details"
			}
			return flags.emit(cmd, result)
		},
	}
	cmd.Flags().IntVar(&depth, "depth", 1, "Number of relationship hops to traverse")
	cmd.Flags().StringVar(&branch, "branch", "", "Branch number of the seed company (head office = 1)")
	return cmd
}

type frontierNode struct{ cr, branch string }
