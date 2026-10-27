package main

import (
	"fmt"
	"io/fs"
	"rawmark/deploy"
	"rawmark/internal/auth"
	"rawmark/internal/store"
	"rawmark/internal/vault"
)

// Keep bootstrap state out of user preferences so resetting settings cannot restore deleted examples.
const examplesSetting = "bootstrap.examples"

func initializeExamples(v *vault.Vault, st *store.Store) error {
	_, done, err := st.Setting(examplesSetting)
	if err != nil || done {
		return err
	}
	setUp, err := auth.New(st).IsSetUp()
	if err != nil {
		return err
	}
	if !setUp {
		examples, err := fs.Sub(deploy.Examples, "data/vault")
		if err != nil {
			return err
		}
		if err := v.SeedExamples(examples); err != nil {
			return fmt.Errorf("初始化示例笔记失败: %w", err)
		}
	}
	return st.SetSetting(examplesSetting, "1")
}
