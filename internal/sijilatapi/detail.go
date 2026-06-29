// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package sijilatapi

import (
	"encoding/json"
	"sort"
	"strings"
)

// Detail is the parsed, agent-friendly view of a CompleteCRDetails response.
type Detail struct {
	CRNumber     string      `json:"cr_number"`
	Branch       string      `json:"branch"`
	NameEN       string      `json:"name_en"`
	NameAR       string      `json:"name_ar"`
	GroupNameEN  string      `json:"group_name_en,omitempty"`
	Nationality  string      `json:"nationality,omitempty"`
	CompanyType  string      `json:"company_type"`
	Status       string      `json:"status"`
	RegisteredOn string      `json:"registered_on"`
	ExpiresOn    string      `json:"expires_on"`
	Address      Address     `json:"address"`
	Capital      Capital     `json:"capital"`
	People       []Person    `json:"people"`
	Amendments   []Amendment `json:"amendments,omitempty"`
	Branches     []Branch    `json:"branches,omitempty"`
}

type Address struct {
	Flat     string `json:"flat,omitempty"`
	Building string `json:"building,omitempty"`
	Road     string `json:"road,omitempty"`
	RoadName string `json:"road_name,omitempty"`
	Block    string `json:"block,omitempty"`
	Town     string `json:"town,omitempty"`
	POBox    string `json:"po_box,omitempty"`
	Email    string `json:"email,omitempty"`
	Mobile   string `json:"mobile,omitempty"`
	Phone    string `json:"phone,omitempty"`
	Fax      string `json:"fax,omitempty"`
	Website  string `json:"website,omitempty"`
}

type Capital struct {
	Authorized    string `json:"authorized,omitempty"`
	Issued        string `json:"issued,omitempty"`
	TotalShares   string `json:"total_shares,omitempty"`
	NominalValue  string `json:"nominal_value,omitempty"`
	Currency      string `json:"currency,omitempty"`
	LocalInvest   string `json:"local_investment,omitempty"`
	GCCInvest     string `json:"gcc_investment,omitempty"`
	ForeignInvest string `json:"foreign_investment,omitempty"`
}

// Person is a shareholder, partner, director, or authorized signatory. The same
// individual may appear in more than one role.
type Person struct {
	Name        string `json:"name"`
	NameAR      string `json:"name_ar,omitempty"`
	Nationality string `json:"nationality,omitempty"`
	Role        string `json:"role"` // shareholder | director | signatory
	Shares      string `json:"shares,omitempty"`
	Ratio       string `json:"ratio,omitempty"`
	Position    string `json:"position,omitempty"`
}

type Amendment struct {
	Date    string `json:"date"`
	Action  string `json:"action"`
	AppNo   string `json:"application_no,omitempty"`
	sortKey string
}

type Branch struct {
	CRNumber     string `json:"cr_number"`
	Branch       string `json:"branch"`
	Name         string `json:"name,omitempty"`
	Status       string `json:"status,omitempty"`
	RegisteredOn string `json:"registered_on,omitempty"`
	ExpiresOn    string `json:"expires_on,omitempty"`
}

func str(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// ParseDetail turns a CompleteCRDetails jsonData payload into a typed Detail.
func ParseDetail(raw json.RawMessage) (*Detail, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil, err
	}
	asObj := func(key string) map[string]any {
		var m map[string]any
		if r, ok := root[key]; ok {
			_ = json.Unmarshal(r, &m)
		}
		return m
	}
	asList := func(key string) []map[string]any {
		var l []map[string]any
		if r, ok := root[key]; ok {
			_ = json.Unmarshal(r, &l)
		}
		return l
	}

	summary := asObj("company_summary")
	addr := asObj("commercialAddress")
	capDetails := asObj("companyCapitalDetails")

	d := &Detail{
		CRNumber:     str(summary, "CR_NO"),
		Branch:       str(summary, "BRANCH_NO"),
		NameEN:       str(summary, "CR_LNM"),
		NameAR:       str(summary, "CR_ANM"),
		GroupNameEN:  str(summary, "CR_GRP_LNM"),
		Nationality:  str(summary, "CR_NAT"),
		CompanyType:  str(summary, "CM_TYP_DESC"),
		Status:       str(summary, "STATUS"),
		RegisteredOn: str(summary, "REG_DATE"),
		ExpiresOn:    str(summary, "EXPIRE_DATE"),
		Address: Address{
			Flat: str(addr, "CR_FLAT"), Building: str(addr, "CR_BULD"),
			Road: str(addr, "CR_ROAD"), RoadName: str(addr, "CR_ROAD_NM"),
			Block: str(addr, "CR_BLOCK"), Town: str(addr, "CR_TOWN_NM"),
			POBox: str(addr, "CR_PBOX"), Email: str(addr, "CR_EMAIL"),
			Mobile: str(addr, "CR_NAT_MOBILE"), Phone: str(addr, "CR_NAT_PHONE_BIS"),
			Fax: str(addr, "CR_NAT_FAX"), Website: firstNonEmpty(str(addr, "CR_URL"), str(addr, "ESTORE_URL")),
		},
		Capital: Capital{
			Authorized: str(capDetails, "AUTH_CAPTL"), Issued: str(capDetails, "ISU_CAPTL"),
			TotalShares: str(capDetails, "TOT_SHARE"), NominalValue: str(capDetails, "NOM_VAL"),
			Currency: str(capDetails, "CURR_CD"), LocalInvest: str(capDetails, "LOCAL_INVEST_SUM"),
			GCCInvest: str(capDetails, "GCC_INVEST_SUM"), ForeignInvest: str(capDetails, "FOR_INVEST_SUM"),
		},
	}

	for _, sh := range asList("shareholdersAndPartners") {
		name := firstNonEmpty(str(sh, "LNM"), str(sh, "NAME"))
		if name == "" {
			continue
		}
		d.People = append(d.People, Person{
			Name: name, NameAR: str(sh, "ANM"),
			Nationality: firstNonEmpty(str(sh, "NAT_LNM"), str(sh, "NAT_NAME")),
			Role:        "shareholder", Shares: str(sh, "NUM_SHARE"), Ratio: str(sh, "RATIO_ONER"),
		})
	}
	for _, dir := range asList("boardofDirectors") {
		name := str(dir, "LNM")
		if name == "" {
			continue
		}
		d.People = append(d.People, Person{
			Name: name, NameAR: str(dir, "ANM"),
			Nationality: firstNonEmpty(str(dir, "NAT_LNM"), str(dir, "NAT_NM")),
			Role:        "director", Position: str(dir, "POSITION_NM"),
		})
	}
	for _, sig := range asList("authorizedSignatories") {
		name := firstNonEmpty(str(sig, "LNM"), str(sig, "NAME"))
		if name == "" {
			continue
		}
		d.People = append(d.People, Person{
			Name: name, NameAR: str(sig, "ANM"),
			Nationality: str(sig, "NAT_NM"),
			Role:        "signatory", Position: str(sig, "SIG_LEV"),
		})
	}

	for _, am := range asList("amendhistory") {
		d.Amendments = append(d.Amendments, Amendment{
			Date:    str(am, "CRT_DATE"),
			Action:  firstNonEmpty(str(am, "AMEND_LNM"), str(am, "AMEND_NM")),
			AppNo:   str(am, "APP_NO"),
			sortKey: str(am, "CRT_DATE_IF"),
		})
	}
	sort.SliceStable(d.Amendments, func(i, j int) bool {
		return d.Amendments[i].sortKey > d.Amendments[j].sortKey // newest first
	})

	for _, br := range asList("otherbranchlist") {
		d.Branches = append(d.Branches, Branch{
			CRNumber: str(br, "CR_NO"), Branch: str(br, "BRANCH_NO"),
			Name: str(br, "CR_NAME"), Status: str(br, "STATUS"),
			RegisteredOn: str(br, "REG_DATE"), ExpiresOn: str(br, "EXPIRE_DATE"),
		})
	}

	return d, nil
}

// Change is a single field-level difference between two detail snapshots.
type Change struct {
	Field string `json:"field"`
	Old   string `json:"old"`
	New   string `json:"new"`
}

// Diff compares two parsed details and returns the meaningful field changes
// (status, expiry, capital, address) plus shareholder/people set changes.
func Diff(old, new *Detail) []Change {
	var ch []Change
	add := func(field, o, n string) {
		if o != n {
			ch = append(ch, Change{Field: field, Old: o, New: n})
		}
	}
	add("status", old.Status, new.Status)
	add("expires_on", old.ExpiresOn, new.ExpiresOn)
	add("company_type", old.CompanyType, new.CompanyType)
	add("name_en", old.NameEN, new.NameEN)
	add("capital.authorized", old.Capital.Authorized, new.Capital.Authorized)
	add("capital.issued", old.Capital.Issued, new.Capital.Issued)
	add("address.email", old.Address.Email, new.Address.Email)
	add("address.phone", old.Address.Phone, new.Address.Phone)
	add("address.building", old.Address.Building, new.Address.Building)

	// People (by name+role) — additions, removals, and share changes.
	oldP := peopleMap(old.People)
	newP := peopleMap(new.People)
	for k, op := range oldP {
		np, ok := newP[k]
		if !ok {
			ch = append(ch, Change{Field: "person.removed (" + op.Role + ")", Old: op.Name, New: ""})
			continue
		}
		if op.Shares != np.Shares {
			ch = append(ch, Change{Field: "person.shares (" + op.Name + ")", Old: op.Shares, New: np.Shares})
		}
	}
	for k, np := range newP {
		if _, ok := oldP[k]; !ok {
			ch = append(ch, Change{Field: "person.added (" + np.Role + ")", Old: "", New: np.Name})
		}
	}
	return ch
}

func peopleMap(people []Person) map[string]Person {
	m := make(map[string]Person, len(people))
	for _, p := range people {
		m[strings.ToUpper(p.Name)+"|"+p.Role] = p
	}
	return m
}
