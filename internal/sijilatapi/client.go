// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package sijilatapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"sijilat-pp-cli/internal/cliutil"
)

const (
	defaultBaseURL = "https://api.sijilat.bh/api/"
	userAgent      = "sijilat-pp-cli (+https://github.com/mvanhorn/printing-press-library)"
)

// Client talks to the Sijilat registry API. It mints and caches the public
// bearer token automatically; callers never supply credentials.
type Client struct {
	BaseURL    string
	TokenURL   string
	HTTPClient *http.Client
	limiter    *cliutil.AdaptiveLimiter

	mu          sync.Mutex
	cachedToken string
	expires     time.Time
	lookups     *LookupTables
}

// New builds a client. baseURL defaults to the production API base; timeout of
// 0 falls back to 60s.
func New(baseURL string, timeout time.Duration) *Client {
	if baseURL == "" {
		baseURL = defaultBaseURL
	}
	if !strings.HasSuffix(baseURL, "/") {
		baseURL += "/"
	}
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	return &Client{
		BaseURL:    baseURL,
		TokenURL:   deriveTokenURL(baseURL),
		HTTPClient: &http.Client{Timeout: timeout},
		// Be a polite client against a government registry: cap request rate
		// and back off adaptively on 429s.
		limiter: cliutil.NewAdaptiveLimiter(4.0),
	}
}

// deriveTokenURL turns "https://api.sijilat.bh/api/" into "https://api.sijilat.bh/token":
// the OAuth token endpoint lives at the host root, not under /api.
func deriveTokenURL(baseURL string) string {
	if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
		return u.Scheme + "://" + u.Host + "/token"
	}
	return "https://api.sijilat.bh/token"
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

// token returns a valid bearer token, minting a fresh one when the cached value
// is missing or within 60s of expiry.
func (c *Client) token(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cachedToken != "" && time.Now().Before(c.expires) {
		return c.cachedToken, nil
	}

	form := url.Values{}
	form.Set("username", tokenUsername)
	form.Set("password", tokenPassword())
	form.Set("grant_type", "password")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", userAgent)

	c.limiter.Wait()
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("requesting token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusTooManyRequests {
		c.limiter.OnRateLimit()
		return "", &cliutil.RateLimitError{URL: c.TokenURL, RetryAfter: cliutil.RetryAfter(resp)}
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint returned HTTP %d", resp.StatusCode)
	}
	c.limiter.OnSuccess()
	var tr tokenResponse
	if err := json.Unmarshal(body, &tr); err != nil || tr.AccessToken == "" {
		return "", fmt.Errorf("parsing token response: %w", err)
	}
	c.cachedToken = tr.AccessToken
	ttl := tr.ExpiresIn
	if ttl <= 0 {
		ttl = 1799
	}
	c.expires = time.Now().Add(time.Duration(ttl-60) * time.Second)
	return c.cachedToken, nil
}

// envelope is the standard response wrapper the API returns for every call.
type envelope struct {
	StatusCode    string          `json:"Status_Code"`
	StatusMessage json.RawMessage `json:"Status_Message"`
	JSONData      json.RawMessage `json:"jsonData"`
}

// post sends a JSON body to path under BaseURL with the bearer token. When
// encrypted is true the body is AES-encrypted (CryptoJS-compatible) as the
// detail endpoints require; otherwise it is sent as plain JSON (search path).
func (c *Client) post(ctx context.Context, path string, body any, encrypted bool) (json.RawMessage, error) {
	tok, err := c.token(ctx)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	var payload io.Reader
	contentType := "application/json; charset=utf-8"
	if encrypted {
		enc, err := encryptBody(raw)
		if err != nil {
			return nil, err
		}
		payload = strings.NewReader(enc)
		contentType = "application/encrypted+json; charset=utf-8"
	} else {
		payload = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("Accept", "*/*")
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("User-Agent", userAgent)

	c.limiter.Wait()
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("POST %s: %w", path, err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	// Surface throttling as a typed error so callers (and fan-out commands)
	// can distinguish "rate-limited" from "no data" instead of silently
	// returning empty results.
	if resp.StatusCode == http.StatusTooManyRequests {
		c.limiter.OnRateLimit()
		return nil, &cliutil.RateLimitError{
			URL:        c.BaseURL + path,
			RetryAfter: cliutil.RetryAfter(resp),
			Body:       strings.TrimSpace(string(respBody)),
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("POST %s returned HTTP %d", path, resp.StatusCode)
	}
	c.limiter.OnSuccess()
	var env envelope
	if err := json.Unmarshal(respBody, &env); err != nil {
		return nil, fmt.Errorf("decoding %s response: %w", path, err)
	}
	if env.StatusCode != "" && env.StatusCode != "200" {
		return nil, fmt.Errorf("API error on %s: status %s: %s", path, env.StatusCode, strings.Trim(string(env.StatusMessage), `"`))
	}
	return env.JSONData, nil
}

// SearchFilters carries the registry's search parameters. Empty fields are
// omitted from the request.
type SearchFilters struct {
	NameEN       string // CR_LNM
	NameAR       string // CR_ANM
	CRNumber     string // CR_NO
	Status       string // STATUS (e.g. ACTIVE)
	Type         string // CM_TYP_CD
	Municipality string // CR_MUNCP_CD
	Block        string // CR_BLOCK
	Nationality  string // CM_NAT_CD
	Sector       string // FIRST_LEV
	Activity     string // ISIC4_CD
	PartnerEN    string // PTNER_LNM
	PartnerAR    string // PTNER_ANM
	PartnerNat   string // PTNER_NAT_CD
	PartnerCR    string // PTNER_CR_NO
	RegFrom      string // REG_DATE_FROM
	RegTo        string // REG_DATE_TO
	Road         string // CR_ROAD
	Flat         string // CR_FLAT
	Building     string // CR_BULD
	Passport     string // PSPORT_NO
	RegType      string // VCR_YN
}

// quoteCodes wraps comma-separated codes the way the site does for code
// filters: "ACTIVE,EXPIRED" -> "'ACTIVE','EXPIRED'". Single values become
// "'ACTIVE'".
func quoteCodes(v string) string {
	if v == "" {
		return ""
	}
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		p = strings.Trim(p, "'")
		out = append(out, "'"+p+"'")
	}
	return strings.Join(out, ",")
}

func (f SearchFilters) body(page, perPage int, langAR bool) map[string]any {
	lang := "EN"
	if langAR {
		lang = "AR"
	}
	start := (page - 1) * perPage
	if start < 0 {
		start = 0
	}
	return map[string]any{
		"draw":   page,
		"start":  start,
		"length": perPage,

		"CR_NO":           f.CRNumber,
		"CR_LNM":          f.NameEN,
		"CR_ANM":          f.NameAR,
		"CM_TYP_CD":       quoteCodes(f.Type),
		"STATUS":          quoteCodes(f.Status),
		"CR_MUNCP_CD":     f.Municipality,
		"CR_BLOCK":        f.Block,
		"CM_NAT_CD":       quoteCodes(f.Nationality),
		"FIRST_LEV":       f.Sector,
		"PTNER_LNM":       f.PartnerEN,
		"PTNER_ANM":       f.PartnerAR,
		"PTNER_NAT_CD":    quoteCodes(f.PartnerNat),
		"REG_DATE_FROM":   f.RegFrom,
		"REG_DATE_TO":     f.RegTo,
		"CR_ROAD":         f.Road,
		"CR_FLAT":         f.Flat,
		"CR_BULD":         f.Building,
		"PSPORT_NO":       f.Passport,
		"PTNER_CR_NO":     f.PartnerCR,
		"VCR_YN":          f.RegType,
		"ISIC4_CD":        quoteCodes(f.Activity),
		"CurrentMenuType": "A",
		"cpr_no":          "",
		"CULT_LANG":       lang,
		"PaginationParams": map[string]any{
			"Page":        page,
			"ItemPerPage": perPage,
		},
	}
}

type searchPayload struct {
	Draw         flexInt         `json:"draw"`
	TotalRecords flexInt         `json:"Total_Records"`
	CRList       json.RawMessage `json:"CR_list"`
}

// flexInt accepts an integer that the API may encode as a JSON number or a
// JSON string (Total_Records comes back quoted).
type flexInt int

func (f *flexInt) UnmarshalJSON(b []byte) error {
	s := strings.Trim(string(b), `"`)
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return fmt.Errorf("flexInt %q: %w", s, err)
	}
	*f = flexInt(n)
	return nil
}

// Company is one search-result row, with agent-friendly field names.
type Company struct {
	CRNumber     string   `json:"cr_number"`
	Branch       string   `json:"branch"`
	NameEN       string   `json:"name_en"`
	NameAR       string   `json:"name_ar"`
	CompanyType  string   `json:"company_type"`
	Status       string   `json:"status"`
	RegisteredOn string   `json:"registered_on"`
	ExpiresOn    string   `json:"expires_on"`
	Activities   []string `json:"activities,omitempty"`
	Sector       string   `json:"sector,omitempty"`
}

type apiRow struct {
	CRNO   string `json:"CR_NO"`
	Branch string `json:"BRANCH_NO"`
	LNM    string `json:"CR_LNM"`
	ANM    string `json:"CR_ANM"`
	Type   string `json:"CM_TYP_DESC"`
	Status string `json:"STATUS"`
	Reg    string `json:"REG_DATE"`
	Expire string `json:"EXPIRE_DATE"`
	Acts   string `json:"ACTIVITIES"`
	Sector string `json:"SECTOR"`
}

func splitActivities(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, "~")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (r apiRow) toCompany() Company {
	return Company{
		CRNumber:     r.CRNO,
		Branch:       r.Branch,
		NameEN:       strings.TrimSpace(r.LNM),
		NameAR:       strings.TrimSpace(r.ANM),
		CompanyType:  r.Type,
		Status:       r.Status,
		RegisteredOn: r.Reg,
		ExpiresOn:    r.Expire,
		Activities:   splitActivities(r.Acts),
		Sector:       r.Sector,
	}
}

// Search runs one page of the registry search and returns the parsed rows plus
// the total match count.
func (c *Client) Search(ctx context.Context, f SearchFilters, page, perPage int, langAR bool) ([]Company, int, error) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 10
	}
	// Code filters (status/type/nationality/sector/municipality) must be sent as
	// registry codes; resolve any human-readable names before searching.
	if err := c.ResolveFilters(ctx, &f); err != nil {
		return nil, 0, err
	}
	data, err := c.post(ctx, "CRdetails/AdvanceSearchCR_Paging", f.body(page, perPage, langAR), false)
	if err != nil {
		return nil, 0, err
	}
	var sp searchPayload
	if err := json.Unmarshal(data, &sp); err != nil {
		return nil, 0, fmt.Errorf("decoding search payload: %w", err)
	}
	var rows []apiRow
	if len(sp.CRList) > 0 {
		if err := json.Unmarshal(sp.CRList, &rows); err != nil {
			return nil, 0, fmt.Errorf("decoding CR_list: %w", err)
		}
	}
	companies := make([]Company, 0, len(rows))
	for _, r := range rows {
		companies = append(companies, r.toCompany())
	}
	return companies, int(sp.TotalRecords), nil
}

// SearchAll pages through the registry search up to maxItems (0 = one page,
// negative = all matches), respecting maxScanPages as a hard cap.
func (c *Client) SearchAll(ctx context.Context, f SearchFilters, perPage, maxItems, maxScanPages int, langAR bool) ([]Company, int, error) {
	if perPage < 1 {
		perPage = 50
	}
	var all []Company
	total := 0
	for page := 1; page <= maxScanPages; page++ {
		rows, t, err := c.Search(ctx, f, page, perPage, langAR)
		if err != nil {
			return all, total, err
		}
		total = t
		all = append(all, rows...)
		if len(rows) < perPage {
			break // last page
		}
		if maxItems > 0 && len(all) >= maxItems {
			break
		}
		if maxItems == 0 {
			break // single page only
		}
	}
	if maxItems > 0 && len(all) > maxItems {
		all = all[:maxItems]
	}
	return all, total, nil
}

// Detail fetches the full company profile for a CR + branch. The request body
// is AES-encrypted as the endpoint requires; the response is plain JSON.
func (c *Client) Detail(ctx context.Context, crNumber, branch string) (json.RawMessage, error) {
	if branch == "" {
		branch = "1"
	}
	body := map[string]any{
		"CR_NO":            crNumber,
		"BRANCH_NO":        branch,
		"cult_lang":        "EN",
		"Input_CULT_LANG":  "EN",
		"CULT_LANG":        "EN",
		"cultLang":         "EN",
		"CurrentMenuTyp":   "A",
		"CurrentMenu_Type": "A",
		"MENU_TYPE":        "A",
	}
	return c.post(ctx, "CRdetails/CompleteCRDetails", body, true)
}

// Reachable performs a cheap token mint to confirm the API is reachable.
func (c *Client) Reachable(ctx context.Context) error {
	_, err := c.token(ctx)
	return err
}
