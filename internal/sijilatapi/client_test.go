// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package sijilatapi

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
)

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// Known-answer test: HMAC-SHA256("UHxNt...gfc", "sijilat_test") in lowercase hex.
// Verified live against the token endpoint during development.
func TestTokenPassword(t *testing.T) {
	const want = "af3ba08ce647fce9b2af578f43ad44905e6e74181f30abb8e43cb0ef3cf2e371"
	if got := tokenPassword(); got != want {
		t.Fatalf("tokenPassword() = %q, want %q", got, want)
	}
}

func TestEncryptBodyFormat(t *testing.T) {
	enc, err := encryptBody([]byte(`{"CR_NO":"21"}`))
	if err != nil {
		t.Fatalf("encryptBody: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		t.Fatalf("output is not base64: %v", err)
	}
	if len(raw) < 16 || string(raw[:8]) != "Salted__" {
		t.Fatalf("ciphertext missing OpenSSL Salted__ header")
	}
	// "Salted__" (8) + salt (8) + at least one AES block (16).
	if len(raw) < 32 {
		t.Fatalf("ciphertext too short: %d bytes", len(raw))
	}
	// Two encryptions of the same plaintext must differ (random salt).
	enc2, _ := encryptBody([]byte(`{"CR_NO":"21"}`))
	if enc == enc2 {
		t.Fatalf("expected differing ciphertext across calls (random salt)")
	}
}

func TestEvpBytesToKeyLengths(t *testing.T) {
	key, iv := evpBytesToKey([]byte(aesPassphrase), []byte("12345678"), 32, 16)
	if len(key) != 32 || len(iv) != 16 {
		t.Fatalf("evpBytesToKey lengths = %d/%d, want 32/16", len(key), len(iv))
	}
}

func TestQuoteCodes(t *testing.T) {
	cases := map[string]string{
		"":                "",
		"ACTIVE":          "'ACTIVE'",
		"ACTIVE,EXPIRED":  "'ACTIVE','EXPIRED'",
		"'ACTIVE'":        "'ACTIVE'",
		" ACTIVE , SOLD ": "'ACTIVE','SOLD'",
	}
	for in, want := range cases {
		if got := quoteCodes(in); got != want {
			t.Errorf("quoteCodes(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSplitActivities(t *testing.T) {
	got := splitActivities("General Trade ~Sale/Trade of Food~Warehousing~")
	want := []string{"General Trade", "Sale/Trade of Food", "Warehousing"}
	if len(got) != len(want) {
		t.Fatalf("splitActivities len = %d, want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("activity[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestDeriveTokenURL(t *testing.T) {
	if got := deriveTokenURL("https://api.sijilat.bh/api/"); got != "https://api.sijilat.bh/token" {
		t.Fatalf("deriveTokenURL = %q", got)
	}
}

func TestApiRowToCompany(t *testing.T) {
	r := apiRow{CRNO: "21", Branch: "10", LNM: " INTERMART ", Acts: "A~B~"}
	c := r.toCompany()
	if c.CRNumber != "21" || c.Branch != "10" || c.NameEN != "INTERMART" {
		t.Fatalf("toCompany mapping wrong: %+v", c)
	}
	if len(c.Activities) != 2 {
		t.Fatalf("activities = %v", c.Activities)
	}
}

// Live smoke test against the real registry. Skipped unless SIJILAT_LIVE=1 so
// CI and offline builds stay deterministic.
func TestLiveTokenSearchDetail(t *testing.T) {
	if os.Getenv("SIJILAT_LIVE") != "1" {
		t.Skip("set SIJILAT_LIVE=1 to run the live registry smoke test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c := New("", 30*time.Second)

	if err := c.Reachable(ctx); err != nil {
		t.Fatalf("token mint failed: %v", err)
	}
	rows, total, err := c.Search(ctx, SearchFilters{NameEN: "TRADING"}, 1, 5, false)
	if err != nil {
		t.Fatalf("search failed: %v", err)
	}
	if total <= 0 || len(rows) == 0 {
		t.Fatalf("search returned no results (total=%d rows=%d)", total, len(rows))
	}
	if rows[0].CRNumber == "" || rows[0].NameEN == "" {
		t.Fatalf("first row missing core fields: %+v", rows[0])
	}
	detail, err := c.Detail(ctx, "21", "10")
	if err != nil {
		t.Fatalf("detail failed: %v", err)
	}
	if !strings.Contains(string(detail), "companyCapitalDetails") {
		t.Fatalf("detail missing expected sections: %s", truncate(string(detail), 200))
	}
}
