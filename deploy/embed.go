// Package deploy embeds the public example vault used by new instances.
package deploy

import "embed"

// Examples is the single source of the example files shipped in every binary.
//
//go:embed data/vault
var Examples embed.FS
