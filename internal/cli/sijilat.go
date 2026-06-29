// Copyright 2026 Baker and contributors. Licensed under Apache-2.0. See LICENSE.

package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"sijilat-pp-cli/internal/cliutil"
	"sijilat-pp-cli/internal/config"
	"sijilat-pp-cli/internal/sijilatapi"
	"sijilat-pp-cli/internal/store"

	"github.com/spf13/cobra"
)

// sijilatClient builds the hand-authored registry client (token mint + AES are
// handled internally; no user credentials are needed).
func (f *rootFlags) sijilatClient() *sijilatapi.Client {
	base := ""
	if cfg, err := config.Load(f.configPath); err == nil {
		base = cfg.BaseURL
	}
	return sijilatapi.New(base, f.timeout)
}

// storePath returns the SQLite mirror path, honoring --home when set.
func (f *rootFlags) storePath() string {
	if f.homePath != "" {
		return filepath.Join(f.homePath, "sijilat.db")
	}
	if dir, err := cliutil.DataDir(); err == nil {
		return filepath.Join(dir, "sijilat.db")
	}
	return "sijilat.db"
}

// openStore opens the mirror for writing (used by sync/watch).
func (f *rootFlags) openStore() (*store.Store, error) {
	path := f.storePath()
	if dir := filepath.Dir(path); dir != "" {
		_ = os.MkdirAll(dir, 0o750)
	}
	return store.Open(path)
}

// openStoreRead opens the mirror, returning missing=true (without writing any
// output) when it does not exist yet. Callers emit their own structured empty
// result + sync hint so the response is parseable and self-describing rather
// than a bare "[]". A stderr breadcrumb names the sync command to run.
func (f *rootFlags) openStoreRead(cmd *cobra.Command, syncHint string) (st *store.Store, missing bool, err error) {
	path := f.storePath()
	if _, statErr := os.Stat(path); os.IsNotExist(statErr) {
		fmt.Fprintf(cmd.ErrOrStderr(), "no local mirror at %s; run: %s\n", path, syncHint)
		return nil, true, nil
	}
	st, err = store.Open(path)
	return st, false, err
}

// noMirror builds a self-describing empty result for store-backed commands when
// the local mirror does not exist yet. Merge it with command-specific keys.
func noMirror(syncHint string, extra map[string]any) map[string]any {
	out := map[string]any{"count": 0, "note": "no local mirror yet; run: " + syncHint}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// emit writes a Go value as JSON, honoring --json/--select/--compact/--agent.
func (f *rootFlags) emit(cmd *cobra.Command, v any) error {
	return printJSONFiltered(cmd.OutOrStdout(), v, f)
}
