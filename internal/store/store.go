// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

// Package store is the local SQLite mirror of synced Sijilat registry data.
// It backs the transcendence commands (graph, controls, diff, feed, expiring,
// stats) that the stateless upstream cannot offer.
package store

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"sijilat-pp-cli/internal/sijilatapi"

	_ "modernc.org/sqlite"
)

type Store struct {
	db *sql.DB
}

// Open opens (and migrates) the SQLite store at path. Single connection: SQLite
// permits one writer and the novel commands use a drain-first query pattern.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("opening store: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// DB exposes the underlying handle for read-only ad-hoc queries.
func (s *Store) DB() *sql.DB { return s.db }

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS companies (
  cr_no TEXT NOT NULL, branch_no TEXT NOT NULL,
  name_en TEXT, name_ar TEXT, company_type TEXT, status TEXT,
  registered_on TEXT, expires_on TEXT, sector TEXT, activities TEXT,
  nationality TEXT, synced_at TEXT,
  PRIMARY KEY (cr_no, branch_no)
);
CREATE TABLE IF NOT EXISTS people (
  cr_no TEXT NOT NULL, branch_no TEXT NOT NULL,
  name TEXT, name_ar TEXT, nationality TEXT, role TEXT, shares TEXT, ratio TEXT
);
CREATE INDEX IF NOT EXISTS idx_people_name ON people (name);
CREATE INDEX IF NOT EXISTS idx_people_cr ON people (cr_no, branch_no);
CREATE TABLE IF NOT EXISTS snapshots (
  cr_no TEXT NOT NULL, branch_no TEXT NOT NULL, taken_at TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_cr ON snapshots (cr_no, branch_no, taken_at);
CREATE TABLE IF NOT EXISTS watchlist (
  cr_no TEXT NOT NULL, branch_no TEXT NOT NULL, added_at TEXT,
  PRIMARY KEY (cr_no, branch_no)
);`
	_, err := s.db.Exec(schema)
	return err
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

// UpsertCompany stores or refreshes a search-result row.
func (s *Store) UpsertCompany(c sijilatapi.Company) error {
	_, err := s.db.Exec(`
INSERT INTO companies (cr_no, branch_no, name_en, name_ar, company_type, status, registered_on, expires_on, sector, activities, synced_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(cr_no, branch_no) DO UPDATE SET
  name_en=excluded.name_en, name_ar=excluded.name_ar, company_type=excluded.company_type,
  status=excluded.status, registered_on=excluded.registered_on, expires_on=excluded.expires_on,
  sector=COALESCE(NULLIF(excluded.sector,''), companies.sector),
  activities=COALESCE(NULLIF(excluded.activities,''), companies.activities),
  synced_at=excluded.synced_at`,
		c.CRNumber, c.Branch, c.NameEN, c.NameAR, c.CompanyType, c.Status,
		c.RegisteredOn, c.ExpiresOn, c.Sector, strings.Join(c.Activities, " | "), nowISO())
	return err
}

// UpsertPeople replaces the people rows for one company with the detail's set,
// and refreshes the company's nationality from the detail people if available.
func (s *Store) UpsertPeople(cr, branch string, people []sijilatapi.Person) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM people WHERE cr_no=? AND branch_no=?`, cr, branch); err != nil {
		return err
	}
	stmt, err := tx.Prepare(`INSERT INTO people (cr_no, branch_no, name, name_ar, nationality, role, shares, ratio) VALUES (?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, p := range people {
		if _, err := stmt.Exec(cr, branch, p.Name, p.NameAR, p.Nationality, p.Role, p.Shares, p.Ratio); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SetCompanyNationality records the company nationality discovered from a
// detail fetch (search rows do not carry it), enabling `stats --by nationality`.
func (s *Store) SetCompanyNationality(cr, branch, nat string) error {
	if nat == "" {
		return nil
	}
	_, err := s.db.Exec(`UPDATE companies SET nationality=? WHERE cr_no=? AND branch_no=?`, nat, cr, branch)
	return err
}

// SaveSnapshot records a detail snapshot used for diffing over time.
func (s *Store) SaveSnapshot(cr, branch string, detailJSON string) error {
	_, err := s.db.Exec(`INSERT INTO snapshots (cr_no, branch_no, taken_at, detail_json) VALUES (?,?,?,?)`,
		cr, branch, nowISO(), detailJSON)
	return err
}

// LatestSnapshot returns the most recent snapshot JSON and its timestamp.
func (s *Store) LatestSnapshot(cr, branch string) (detailJSON, takenAt string, ok bool, err error) {
	row := s.db.QueryRow(`SELECT detail_json, taken_at FROM snapshots WHERE cr_no=? AND branch_no=? ORDER BY taken_at DESC LIMIT 1`, cr, branch)
	err = row.Scan(&detailJSON, &takenAt)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	return detailJSON, takenAt, true, nil
}

// Watch / watchlist ----------------------------------------------------------

func (s *Store) AddWatch(cr, branch string) error {
	_, err := s.db.Exec(`INSERT INTO watchlist (cr_no, branch_no, added_at) VALUES (?,?,?) ON CONFLICT(cr_no, branch_no) DO NOTHING`, cr, branch, nowISO())
	return err
}

func (s *Store) RemoveWatch(cr, branch string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM watchlist WHERE cr_no=? AND branch_no=?`, cr, branch)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

type WatchEntry struct {
	CRNumber string `json:"cr_number"`
	Branch   string `json:"branch"`
	NameEN   string `json:"name_en,omitempty"`
	Status   string `json:"status,omitempty"`
	AddedAt  string `json:"added_at,omitempty"`
}

func (s *Store) ListWatch() ([]WatchEntry, error) {
	rows, err := s.db.Query(`
SELECT w.cr_no, w.branch_no, COALESCE(c.name_en,''), COALESCE(c.status,''), COALESCE(w.added_at,'')
FROM watchlist w LEFT JOIN companies c ON c.cr_no=w.cr_no AND c.branch_no=w.branch_no
ORDER BY w.cr_no, w.branch_no`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WatchEntry
	for rows.Next() {
		var e WatchEntry
		if err := rows.Scan(&e.CRNumber, &e.Branch, &e.NameEN, &e.Status, &e.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Queries --------------------------------------------------------------------

func (s *Store) CompanyCount() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM companies`).Scan(&n)
	return n, err
}

func (s *Store) PeopleCount() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM people`).Scan(&n)
	return n, err
}

// SearchLocal runs an offline name/activity match over synced companies.
func (s *Store) SearchLocal(query string, limit int) ([]sijilatapi.Company, error) {
	if limit <= 0 {
		limit = 50
	}
	like := "%" + query + "%"
	rows, err := s.db.Query(`
SELECT cr_no, branch_no, name_en, name_ar, company_type, status, registered_on, expires_on, COALESCE(sector,''), COALESCE(activities,'')
FROM companies
WHERE name_en LIKE ? OR name_ar LIKE ? OR activities LIKE ?
ORDER BY name_en LIMIT ?`, like, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []sijilatapi.Company
	for rows.Next() {
		var c sijilatapi.Company
		var acts string
		if err := rows.Scan(&c.CRNumber, &c.Branch, &c.NameEN, &c.NameAR, &c.CompanyType, &c.Status, &c.RegisteredOn, &c.ExpiresOn, &c.Sector, &acts); err != nil {
			return nil, err
		}
		if acts != "" {
			c.Activities = strings.Split(acts, " | ")
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// ControlRow is one company a person is involved in.
type ControlRow struct {
	CRNumber string `json:"cr_number"`
	Branch   string `json:"branch"`
	NameEN   string `json:"company_name_en"`
	Role     string `json:"role"`
	Shares   string `json:"shares,omitempty"`
	Ratio    string `json:"ratio,omitempty"`
	Status   string `json:"company_status,omitempty"`
}

// Controls returns every company a person (matched by name substring,
// case-insensitive) is a shareholder, director, or signatory of.
func (s *Store) Controls(name string) ([]ControlRow, error) {
	like := "%" + strings.ToUpper(name) + "%"
	rows, err := s.db.Query(`
SELECT p.cr_no, p.branch_no, COALESCE(c.name_en,''), p.role, COALESCE(p.shares,''), COALESCE(p.ratio,''), COALESCE(c.status,'')
FROM people p LEFT JOIN companies c ON c.cr_no=p.cr_no AND c.branch_no=p.branch_no
WHERE UPPER(p.name) LIKE ?
ORDER BY p.cr_no, p.branch_no`, like)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ControlRow
	for rows.Next() {
		var r ControlRow
		if err := rows.Scan(&r.CRNumber, &r.Branch, &r.NameEN, &r.Role, &r.Shares, &r.Ratio, &r.Status); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PeopleOf returns the distinct person names tied to a company in the store.
func (s *Store) PeopleOf(cr, branch string) ([]string, error) {
	rows, err := s.db.Query(`SELECT DISTINCT name FROM people WHERE cr_no=? AND branch_no=? AND name<>''`, cr, branch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// GraphEdge links a company to a related company through a shared person.
type GraphEdge struct {
	FromCR   string `json:"from_cr"`
	ToCR     string `json:"to_cr"`
	ToBranch string `json:"to_branch"`
	ToName   string `json:"to_name_en"`
	Via      string `json:"via_person"`
}

// RelatedCompanies finds companies that share at least one person with the
// given person names, excluding the seed company.
func (s *Store) RelatedCompanies(seedCR string, personNames []string) ([]GraphEdge, error) {
	if len(personNames) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(personNames)), ",")
	args := make([]any, 0, len(personNames)+1)
	for _, n := range personNames {
		args = append(args, strings.ToUpper(n))
	}
	args = append(args, seedCR)
	// #nosec G201 -- only the generated "?,?,..." placeholder string is interpolated; every user value is bound via args.
	q := fmt.Sprintf(`
SELECT DISTINCT p.cr_no, p.branch_no, COALESCE(c.name_en,''), p.name
FROM people p LEFT JOIN companies c ON c.cr_no=p.cr_no AND c.branch_no=p.branch_no
WHERE UPPER(p.name) IN (%s) AND p.cr_no <> ?
ORDER BY p.cr_no, p.branch_no`, placeholders)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GraphEdge
	for rows.Next() {
		var e GraphEdge
		e.FromCR = seedCR
		if err := rows.Scan(&e.ToCR, &e.ToBranch, &e.ToName, &e.Via); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// StatRow is one aggregation bucket.
type StatRow struct {
	Key   string `json:"key"`
	Count int    `json:"count"`
}

// Stats groups synced companies by one dimension: status, company_type,
// nationality, sector, or year (registration year).
func (s *Store) Stats(dimension string) ([]StatRow, error) {
	var expr string
	switch dimension {
	case "status":
		expr = "COALESCE(NULLIF(status,''),'(unknown)')"
	case "type", "company_type":
		expr = "COALESCE(NULLIF(company_type,''),'(unknown)')"
	case "nationality":
		expr = "COALESCE(NULLIF(nationality,''),'(unknown)')"
	case "sector":
		expr = "COALESCE(NULLIF(sector,''),'(unknown)')"
	case "year", "reg-year":
		// registered_on is DD/MM/YYYY; take the trailing year.
		expr = "CASE WHEN length(registered_on)>=4 THEN substr(registered_on,-4) ELSE '(unknown)' END"
	default:
		return nil, fmt.Errorf("unknown dimension %q (use status, type, nationality, sector, or year)", dimension)
	}
	// #nosec G202 -- expr is selected from the fixed switch whitelist above; the dimension argument never reaches the query text directly.
	rows, err := s.db.Query(`SELECT ` + expr + ` AS k, COUNT(*) AS n FROM companies GROUP BY k ORDER BY n DESC, k`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StatRow
	for rows.Next() {
		var r StatRow
		if err := rows.Scan(&r.Key, &r.Count); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ExpiringRow is a company approaching or past its expiry.
type ExpiringRow struct {
	CRNumber  string `json:"cr_number"`
	Branch    string `json:"branch"`
	NameEN    string `json:"name_en"`
	Status    string `json:"status"`
	ExpiresOn string `json:"expires_on"`
	DaysLeft  int    `json:"days_left"`
	Lapsed    bool   `json:"lapsed"`
}

// Expiring returns companies whose CR expires within withinDays (past expiry
// included). When watchedOnly is true, only watchlist companies are considered.
func (s *Store) Expiring(withinDays int, watchedOnly bool) ([]ExpiringRow, error) {
	q := `SELECT cr_no, branch_no, COALESCE(name_en,''), COALESCE(status,''), COALESCE(expires_on,'') FROM companies`
	if watchedOnly {
		q = `SELECT c.cr_no, c.branch_no, COALESCE(c.name_en,''), COALESCE(c.status,''), COALESCE(c.expires_on,'')
FROM companies c JOIN watchlist w ON w.cr_no=c.cr_no AND w.branch_no=c.branch_no`
	}
	rows, err := s.db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type rawRow struct{ cr, branch, name, status, expires string }
	var raws []rawRow
	for rows.Next() {
		var r rawRow
		if err := rows.Scan(&r.cr, &r.branch, &r.name, &r.status, &r.expires); err != nil {
			return nil, err
		}
		raws = append(raws, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := time.Now()
	var out []ExpiringRow
	for _, r := range raws {
		exp, ok := parseDMY(r.expires)
		if !ok {
			continue
		}
		days := int(exp.Sub(now).Hours() / 24)
		if days <= withinDays {
			out = append(out, ExpiringRow{
				CRNumber: r.cr, Branch: r.branch, NameEN: r.name, Status: r.status,
				ExpiresOn: r.expires, DaysLeft: days, Lapsed: days < 0 || !strings.EqualFold(r.status, "ACTIVE"),
			})
		}
	}
	return out, nil
}

// parseDMY parses a DD/MM/YYYY date.
func parseDMY(s string) (time.Time, bool) {
	t, err := time.Parse("02/01/2006", strings.TrimSpace(s))
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
