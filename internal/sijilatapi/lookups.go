// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package sijilatapi

import (
	"context"
	"encoding/json"
	"strings"
)

// CodeName is one entry in a registry lookup table (a filter code plus its
// human-readable name and optional flag/grouping).
type CodeName struct {
	Code string `json:"code"`
	Name string `json:"name"`
	Flag string `json:"flag,omitempty"`
}

// LookupTables holds the registry's filter code tables (status, company type,
// nationality, sector, municipality). The search endpoint expects these codes,
// not the human-readable names, so the client resolves names to codes.
type LookupTables struct {
	Status         []CodeName `json:"status"`
	Types          []CodeName `json:"types"`
	Nationalities  []CodeName `json:"nationalities"`
	Sectors        []CodeName `json:"sectors"`
	Municipalities []CodeName `json:"municipalities"`
}

// Lookups fetches (and caches per process) the registry filter code tables.
func (c *Client) Lookups(ctx context.Context) (*LookupTables, error) {
	c.mu.Lock()
	cached := c.lookups
	c.mu.Unlock()
	if cached != nil {
		return cached, nil
	}

	body := map[string]any{
		"cult_lang": "EN", "CULT_LANG": "EN", "CurrentMenuTyp": "A", "MENU_TYPE": "A",
	}
	data, err := c.post(ctx, "Common/AdvanceSrch_lookup", body, true)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Status []struct {
			Code string `json:"STATUS_CD"`
			Name string `json:"STATUS_NM"`
			Flag string `json:"STATUS_FLAG"`
		} `json:"CR_Status_lst"`
		Types []struct {
			Code string `json:"CM_TYP_CD"`
			Name string `json:"CM_TYP_NM"`
			Flag string `json:"CR_TYPE"`
		} `json:"Company_Type_lst"`
		Nationalities []struct {
			Code string `json:"NAT_CD"`
			Name string `json:"NAT_NM"`
			Flag string `json:"NAT_FLAG"`
		} `json:"Nationality_lst"`
		Sectors []struct {
			Code string `json:"FIRST_LEV"`
			Name string `json:"ISIC4_NM"`
		} `json:"Sectorlist"`
		Municipalities []struct {
			Code string `json:"MUNCP_CD"`
			Name string `json:"MUNI_DESC"`
		} `json:"Municipality_lst"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	lt := &LookupTables{}
	for _, s := range raw.Status {
		lt.Status = append(lt.Status, CodeName{Code: s.Code, Name: s.Name, Flag: s.Flag})
	}
	for _, t := range raw.Types {
		lt.Types = append(lt.Types, CodeName{Code: t.Code, Name: t.Name, Flag: t.Flag})
	}
	for _, n := range raw.Nationalities {
		lt.Nationalities = append(lt.Nationalities, CodeName{Code: n.Code, Name: n.Name, Flag: n.Flag})
	}
	for _, s := range raw.Sectors {
		lt.Sectors = append(lt.Sectors, CodeName{Code: s.Code, Name: s.Name})
	}
	for _, m := range raw.Municipalities {
		lt.Municipalities = append(lt.Municipalities, CodeName{Code: m.Code, Name: m.Name})
	}

	c.mu.Lock()
	c.lookups = lt
	c.mu.Unlock()
	return lt, nil
}

func isAllDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// resolveCodes maps a comma-separated list of names/flags/codes to registry
// codes using a lookup table. Numeric tokens pass through untouched. For each
// name token it tries an exact (case-insensitive) name match, then a flag
// match (expanding to every code with that flag), then a unique substring
// match; unmatched tokens are left as-is.
func resolveCodes(table []CodeName, value string) string {
	if value == "" || len(table) == 0 {
		return value
	}
	var out []string
	for _, tok := range strings.Split(value, ",") {
		tok = strings.TrimSpace(strings.Trim(tok, "'"))
		if tok == "" {
			continue
		}
		if isAllDigits(tok) {
			out = append(out, tok)
			continue
		}
		lower := strings.ToLower(tok)
		// 1. exact name match
		matched := false
		for _, e := range table {
			if strings.ToLower(e.Name) == lower {
				out = append(out, e.Code)
				matched = true
				break
			}
		}
		if matched {
			continue
		}
		// 2. flag match (expand to all codes sharing the flag)
		var flagCodes []string
		for _, e := range table {
			if e.Flag != "" && strings.ToLower(e.Flag) == lower {
				flagCodes = append(flagCodes, e.Code)
			}
		}
		if len(flagCodes) > 0 {
			out = append(out, flagCodes...)
			continue
		}
		// 3. unique substring match
		var subCodes []string
		for _, e := range table {
			if strings.Contains(strings.ToLower(e.Name), lower) {
				subCodes = append(subCodes, e.Code)
			}
		}
		if len(subCodes) == 1 {
			out = append(out, subCodes[0])
			continue
		}
		// Unmatched (or ambiguous) — leave as the user typed it.
		out = append(out, tok)
	}
	return strings.Join(out, ",")
}

// ResolveFilters rewrites name-based code filters (status, type, nationality,
// sector, municipality) into registry codes, fetching the lookup tables only
// when at least one such filter needs resolving.
func (c *Client) ResolveFilters(ctx context.Context, f *SearchFilters) error {
	if !needsResolve(f) {
		return nil
	}
	lt, err := c.Lookups(ctx)
	if err != nil {
		return err
	}
	f.Status = resolveCodes(lt.Status, f.Status)
	f.Type = resolveCodes(lt.Types, f.Type)
	f.Nationality = resolveCodes(lt.Nationalities, f.Nationality)
	f.Sector = resolveCodes(lt.Sectors, f.Sector)
	f.Municipality = resolveCodes(lt.Municipalities, f.Municipality)
	return nil
}

// needsResolve reports whether any code filter contains a non-numeric token
// that requires the lookup tables.
func needsResolve(f *SearchFilters) bool {
	for _, v := range []string{f.Status, f.Type, f.Nationality, f.Sector, f.Municipality} {
		if v == "" {
			continue
		}
		for _, tok := range strings.Split(v, ",") {
			tok = strings.TrimSpace(strings.Trim(tok, "'"))
			if tok != "" && !isAllDigits(tok) {
				return true
			}
		}
	}
	return false
}
