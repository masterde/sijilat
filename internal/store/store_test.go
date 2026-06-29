// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package store

import (
	"path/filepath"
	"testing"

	"sijilat-pp-cli/internal/sijilatapi"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func seed(t *testing.T, st *Store) {
	t.Helper()
	companies := []sijilatapi.Company{
		{CRNumber: "100", Branch: "1", NameEN: "ALPHA TRADING WLL", Status: "ACTIVE", RegisteredOn: "01/02/2010", ExpiresOn: "01/02/2030", CompanyType: "WLL"},
		{CRNumber: "200", Branch: "1", NameEN: "BETA SERVICES WLL", Status: "ACTIVE", RegisteredOn: "05/06/2015", ExpiresOn: "05/06/2024", CompanyType: "WLL"},
		{CRNumber: "300", Branch: "1", NameEN: "GAMMA HOLDING", Status: "EXPIRED", RegisteredOn: "09/09/2010", ExpiresOn: "09/09/2020", CompanyType: "SPC"},
	}
	for _, c := range companies {
		if err := st.UpsertCompany(c); err != nil {
			t.Fatalf("UpsertCompany: %v", err)
		}
	}
	if err := st.SetCompanyNationality("100", "1", "BAHRAINI"); err != nil {
		t.Fatal(err)
	}
	// Person "JOHN DOE" links companies 100 and 200; "JANE ROE" is unique to 100.
	if err := st.UpsertPeople("100", "1", []sijilatapi.Person{
		{Name: "JOHN DOE", Role: "shareholder", Shares: "50"},
		{Name: "JANE ROE", Role: "director"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := st.UpsertPeople("200", "1", []sijilatapi.Person{
		{Name: "JOHN DOE", Role: "signatory"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestControlsReverseLookup(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	rows, err := st.Controls("john doe")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("Controls(john doe) = %d rows, want 2: %+v", len(rows), rows)
	}
	seen := map[string]bool{}
	for _, r := range rows {
		seen[r.CRNumber] = true
	}
	if !seen["100"] || !seen["200"] {
		t.Fatalf("expected JOHN DOE in CR 100 and 200, got %+v", rows)
	}
}

func TestRelatedCompaniesGraphEdge(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	people, err := st.PeopleOf("100", "1")
	if err != nil {
		t.Fatal(err)
	}
	edges, err := st.RelatedCompanies("100", people)
	if err != nil {
		t.Fatal(err)
	}
	if len(edges) != 1 {
		t.Fatalf("RelatedCompanies(100) = %d edges, want 1 (CR 200 via JOHN DOE): %+v", len(edges), edges)
	}
	if edges[0].ToCR != "200" || edges[0].Via != "JOHN DOE" {
		t.Fatalf("unexpected edge: %+v", edges[0])
	}
}

func TestStatsDimensions(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	rows, err := st.Stats("status")
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, r := range rows {
		counts[r.Key] = r.Count
	}
	if counts["ACTIVE"] != 2 || counts["EXPIRED"] != 1 {
		t.Fatalf("status stats = %+v, want ACTIVE:2 EXPIRED:1", counts)
	}
	years, err := st.Stats("year")
	if err != nil {
		t.Fatal(err)
	}
	yc := map[string]int{}
	for _, r := range years {
		yc[r.Key] = r.Count
	}
	if yc["2010"] != 2 {
		t.Fatalf("year stats = %+v, want 2010:2", yc)
	}
	if _, err := st.Stats("bogus"); err == nil {
		t.Fatalf("expected error for unknown dimension")
	}
}

func TestExpiringWindowAndLapsed(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	// A very wide window returns all three; GAMMA (2020) and BETA (2024) are
	// past expiry -> lapsed; ALPHA (2030) is future + ACTIVE -> not lapsed.
	rows, err := st.Expiring(1000000, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 {
		t.Fatalf("Expiring wide window = %d, want 3", len(rows))
	}
	lapsed := map[string]bool{}
	for _, r := range rows {
		lapsed[r.CRNumber] = r.Lapsed
	}
	if lapsed["100"] {
		t.Errorf("ALPHA (future, ACTIVE) should not be lapsed")
	}
	if !lapsed["300"] {
		t.Errorf("GAMMA (past expiry) should be lapsed")
	}
}

func TestSearchLocalAndNationalityStat(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	res, err := st.SearchLocal("trading", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].CRNumber != "100" {
		t.Fatalf("SearchLocal(trading) = %+v, want CR 100", res)
	}
	nat, err := st.Stats("nationality")
	if err != nil {
		t.Fatal(err)
	}
	var bahraini int
	for _, r := range nat {
		if r.Key == "BAHRAINI" {
			bahraini = r.Count
		}
	}
	if bahraini != 1 {
		t.Fatalf("nationality BAHRAINI = %d, want 1", bahraini)
	}
}

func TestWatchlistRoundTrip(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	if err := st.AddWatch("100", "1"); err != nil {
		t.Fatal(err)
	}
	if err := st.AddWatch("100", "1"); err != nil { // idempotent
		t.Fatal(err)
	}
	list, err := st.ListWatch()
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].CRNumber != "100" {
		t.Fatalf("ListWatch = %+v, want one entry CR 100", list)
	}
	if list[0].NameEN != "ALPHA TRADING WLL" {
		t.Fatalf("watch entry should join company name, got %q", list[0].NameEN)
	}
	removed, err := st.RemoveWatch("100", "1")
	if err != nil || !removed {
		t.Fatalf("RemoveWatch = %v, %v", removed, err)
	}
}
