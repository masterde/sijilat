// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"context"
	"encoding/json"

	"sijilat-pp-cli/internal/sijilatapi"
	"sijilat-pp-cli/internal/store"
)

// detailToCompany derives the search-row company shape from a parsed detail so
// the companies table stays populated even when only details are fetched.
func detailToCompany(d *sijilatapi.Detail) sijilatapi.Company {
	return sijilatapi.Company{
		CRNumber:     d.CRNumber,
		Branch:       d.Branch,
		NameEN:       d.NameEN,
		NameAR:       d.NameAR,
		CompanyType:  d.CompanyType,
		Status:       d.Status,
		RegisteredOn: d.RegisteredOn,
		ExpiresOn:    d.ExpiresOn,
	}
}

// fetchAndStoreDetail fetches a live company profile, stores its company row,
// people, and nationality, computes changes versus the latest snapshot (if any),
// and — when saveSnapshot is true — records a new snapshot for future diffs.
func fetchAndStoreDetail(ctx context.Context, c *sijilatapi.Client, st *store.Store, cr, branch string, saveSnapshot bool) (cur *sijilatapi.Detail, changes []sijilatapi.Change, hadPrior bool, err error) {
	if branch == "" {
		branch = "1"
	}
	raw, err := c.Detail(ctx, cr, branch)
	if err != nil {
		return nil, nil, false, err
	}
	cur, err = sijilatapi.ParseDetail(raw)
	if err != nil {
		return nil, nil, false, err
	}

	if prevJSON, _, ok, lerr := st.LatestSnapshot(cr, branch); lerr == nil && ok {
		hadPrior = true
		var prev sijilatapi.Detail
		if json.Unmarshal([]byte(prevJSON), &prev) == nil {
			changes = sijilatapi.Diff(&prev, cur)
		}
	}

	if err = st.UpsertCompany(detailToCompany(cur)); err != nil {
		return cur, changes, hadPrior, err
	}
	if err = st.UpsertPeople(cr, branch, cur.People); err != nil {
		return cur, changes, hadPrior, err
	}
	if err = st.SetCompanyNationality(cr, branch, cur.Nationality); err != nil {
		return cur, changes, hadPrior, err
	}
	if saveSnapshot {
		canon, _ := json.Marshal(cur)
		if err = st.SaveSnapshot(cr, branch, string(canon)); err != nil {
			return cur, changes, hadPrior, err
		}
	}
	return cur, changes, hadPrior, nil
}
