// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"strings"

	"sijilat-pp-cli/internal/cliutil"
	"sijilat-pp-cli/internal/sijilatapi"

	"github.com/spf13/cobra"
)

// searchFlags holds the shared registry-search flags so both the top-level
// `search` command and the spec-aligned `cr search` command can reuse them.
type searchFlags struct {
	f            sijilatapi.SearchFilters
	limit        int
	maxScanPages int
	all          bool
	local        bool
	langAR       bool
}

func registerSearchFlags(cmd *cobra.Command, s *searchFlags) {
	fl := cmd.Flags()
	fl.StringVar(&s.f.NameEN, "name-en", "", "English company name (partial match)")
	fl.StringVar(&s.f.NameAR, "name-ar", "", "Arabic company name (partial match)")
	fl.StringVar(&s.f.CRNumber, "cr", "", "Commercial Registration number")
	fl.StringVar(&s.f.Status, "status", "", "Status filter: ACTIVE, EXPIRED, CANCELLED (comma-separated for multiple)")
	fl.StringVar(&s.f.Type, "type", "", "Company type code(s)")
	fl.StringVar(&s.f.Municipality, "municipality", "", "Municipality code")
	fl.StringVar(&s.f.Nationality, "nationality", "", "Company nationality code (BAHRAINI/GCC/FOREIGN coded)")
	fl.StringVar(&s.f.Sector, "sector", "", "Economic sector code")
	fl.StringVar(&s.f.Activity, "activity", "", "ISIC4 activity code(s)")
	fl.StringVar(&s.f.PartnerEN, "partner", "", "Partner/shareholder English name")
	fl.StringVar(&s.f.PartnerAR, "partner-ar", "", "Partner/shareholder Arabic name")
	fl.StringVar(&s.f.PartnerNat, "partner-nat", "", "Partner nationality code")
	fl.StringVar(&s.f.PartnerCR, "partner-cr", "", "Partner's CR number")
	fl.StringVar(&s.f.RegFrom, "reg-from", "", "Registered on or after (DD/MM/YYYY)")
	fl.StringVar(&s.f.RegTo, "reg-to", "", "Registered on or before (DD/MM/YYYY)")
	fl.StringVar(&s.f.Road, "road", "", "Road number")
	fl.StringVar(&s.f.Block, "block", "", "Block number")
	fl.StringVar(&s.f.Building, "building", "", "Building number")
	fl.StringVar(&s.f.Passport, "passport", "", "Partner passport number")
	fl.IntVar(&s.limit, "limit", 25, "Maximum results to return (ignored with --all)")
	fl.BoolVar(&s.all, "all", false, "Page through every match (bounded by --max-scan-pages)")
	fl.IntVar(&s.maxScanPages, "max-scan-pages", 20, "Maximum result pages to fetch when paging")
	fl.BoolVar(&s.local, "local", false, "Search the synced local mirror offline instead of the live API")
	fl.BoolVar(&s.langAR, "ar", false, "Search using the Arabic culture (affects name matching)")
}

func newSearchCmd(flags *rootFlags) *cobra.Command {
	s := &searchFlags{}
	cmd := &cobra.Command{
		Use:   "search",
		Short: "Search Bahrain's commercial registry by name (EN/AR), CR number, status, type, sector, activity, partner, nationality, municipality, or address",
		Long: strings.Trim(`
Search the live Sijilat registry across ~20 filters. With no filters it errors;
supply at least one (e.g. --name-en, --cr, --status). Use --all to page through
every match (bounded by --max-scan-pages), --local to search the synced mirror
offline, and --ar to search by the Arabic culture.`, "\n"),
		Example: strings.Trim(`
  sijilat search --name-en trading --limit 10
  sijilat search --name-en "general trading" --status ACTIVE --json --select cr_number,name_en,status
  sijilat search --cr 21
  sijilat search --name-en cafe --all --max-scan-pages 5
  sijilat search --local cafe`, "\n"),
		Annotations: map[string]string{"mcp:read-only": "true"},
		RunE: func(cmd *cobra.Command, args []string) error {
			return runRegistrySearch(cmd, flags, s, args)
		},
	}
	registerSearchFlags(cmd, s)
	return cmd
}

// runRegistrySearch is the shared search implementation behind both the
// top-level `search` command and the spec-aligned `cr search` command.
func runRegistrySearch(cmd *cobra.Command, flags *rootFlags, s *searchFlags, args []string) error {
	f := s.f
	// Allow a bare positional as a convenience name query.
	if len(args) > 0 && f.NameEN == "" && f.NameAR == "" && f.CRNumber == "" {
		if s.langAR {
			f.NameAR = strings.Join(args, " ")
		} else {
			f.NameEN = strings.Join(args, " ")
		}
	}
	if len(args) == 0 && cmd.Flags().NFlag() == 0 {
		return cmd.Help()
	}
	if dryRunOK(flags) {
		fmt.Fprintln(cmd.OutOrStdout(), "would search the Sijilat registry")
		return nil
	}

	if s.local {
		query := firstNonEmptyStr(f.NameEN, f.NameAR, f.CRNumber)
		if query == "" {
			_ = cmd.Usage()
			return usageErr(fmt.Errorf("--local search needs a query (e.g. --name-en cafe or a positional)"))
		}
		st, missing, err := flags.openStoreRead(cmd, "sijilat sync --name-en <term>")
		if err != nil {
			return err
		}
		if missing {
			return flags.emit(cmd, noMirror("sijilat sync --name-en "+query, map[string]any{
				"source": "local", "query": query, "returned": 0, "results": []sijilatapi.Company{},
			}))
		}
		defer st.Close()
		rows, err := st.SearchLocal(query, limitOrDefault(s.limit, 50))
		if err != nil {
			return fmt.Errorf("local search: %w", err)
		}
		return flags.emit(cmd, map[string]any{
			"source": "local", "query": query, "returned": len(rows), "results": rows,
		})
	}

	if !anyFilterSet(f) {
		_ = cmd.Usage()
		return usageErr(fmt.Errorf("supply at least one filter (e.g. --name-en, --cr, --status)"))
	}

	ctx, cancel := boundCtx(cmd.Context(), flags)
	defer cancel()

	perPage := 50
	maxItems := limitOrDefault(s.limit, 25)
	if s.all {
		maxItems = -1
	}
	scan := s.maxScanPages
	if scan <= 0 {
		scan = 20
	}
	if cliutil.IsDogfoodEnv() && scan > 1 {
		scan = 1
	}
	rows, total, err := flags.sijilatClient().SearchAll(ctx, f, perPage, maxItems, scan, s.langAR)
	if err != nil {
		return fmt.Errorf("searching registry: %w", err)
	}
	return flags.emit(cmd, map[string]any{
		"source":        "live",
		"total_matches": total,
		"returned":      len(rows),
		"results":       rows,
	})
}

func anyFilterSet(f sijilatapi.SearchFilters) bool {
	return f.NameEN != "" || f.NameAR != "" || f.CRNumber != "" || f.Status != "" ||
		f.Type != "" || f.Municipality != "" || f.Nationality != "" || f.Sector != "" ||
		f.Activity != "" || f.PartnerEN != "" || f.PartnerAR != "" || f.PartnerNat != "" ||
		f.PartnerCR != "" || f.RegFrom != "" || f.RegTo != "" || f.Road != "" ||
		f.Block != "" || f.Building != "" || f.Passport != ""
}

func firstNonEmptyStr(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func limitOrDefault(n, def int) int {
	if n <= 0 {
		return def
	}
	return n
}
