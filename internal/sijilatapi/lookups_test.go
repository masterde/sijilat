// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package sijilatapi

import "testing"

var statusTable = []CodeName{
	{Code: "3103", Name: "ACTIVE", Flag: "Active"},
	{Code: "3108", Name: "FROZEN", Flag: "Active"},
	{Code: "3104", Name: "DELETED WITH PAYMENT", Flag: "Deleted"},
	{Code: "3115", Name: "SOLD OR LEGAL STATUS CHANGED", Flag: "Deleted"},
}

func TestResolveCodesExactName(t *testing.T) {
	if got := resolveCodes(statusTable, "ACTIVE"); got != "3103" {
		t.Fatalf("resolveCodes(ACTIVE) = %q, want 3103", got)
	}
	if got := resolveCodes(statusTable, "active"); got != "3103" {
		t.Fatalf("case-insensitive name match failed: %q", got)
	}
	if got := resolveCodes(statusTable, "SOLD OR LEGAL STATUS CHANGED"); got != "3115" {
		t.Fatalf("multi-word name match failed: %q", got)
	}
}

func TestResolveCodesNumericPassthrough(t *testing.T) {
	if got := resolveCodes(statusTable, "3103"); got != "3103" {
		t.Fatalf("numeric code should pass through, got %q", got)
	}
	if got := resolveCodes(statusTable, "3103,3104"); got != "3103,3104" {
		t.Fatalf("numeric list should pass through, got %q", got)
	}
}

func TestResolveCodesFlagExpansion(t *testing.T) {
	// "Deleted" flag expands to all Deleted-flagged codes.
	got := resolveCodes(statusTable, "Deleted")
	if got != "3104,3115" {
		t.Fatalf("flag expansion = %q, want 3104,3115", got)
	}
}

func TestResolveCodesMixedAndUnmatched(t *testing.T) {
	if got := resolveCodes(statusTable, "ACTIVE,3104"); got != "3103,3104" {
		t.Fatalf("mixed name+code = %q, want 3103,3104", got)
	}
	// Unknown token is left as-is (server will reject; surfaces a clear error).
	if got := resolveCodes(statusTable, "NONSENSE"); got != "NONSENSE" {
		t.Fatalf("unmatched token should pass through, got %q", got)
	}
}

func TestNeedsResolve(t *testing.T) {
	if needsResolve(&SearchFilters{Status: "3103"}) {
		t.Fatalf("numeric status should not need resolve")
	}
	if !needsResolve(&SearchFilters{Status: "ACTIVE"}) {
		t.Fatalf("name status should need resolve")
	}
	if needsResolve(&SearchFilters{NameEN: "trading"}) {
		t.Fatalf("name-only search should not need code resolution")
	}
}
