package api

import (
	"encoding/json"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"testing"
)

type documentedSchema struct {
	Ref        string                       `json:"$ref"`
	Const      json.RawMessage              `json:"const"`
	Required   []string                     `json:"required"`
	Properties map[string]*documentedSchema `json:"properties"`
}

type documentedOperation struct {
	Responses map[string]struct {
		Content map[string]struct{ Schema documentedSchema }
	}
}

func TestOpenAPIResponseContracts(t *testing.T) {
	var spec struct {
		Paths      map[string]map[string]json.RawMessage
		Components struct{ Schemas map[string]documentedSchema }
	}
	if err := json.Unmarshal(openAPISpec, &spec); err != nil {
		t.Fatal(err)
	}
	operation := func(path, method string) documentedOperation {
		t.Helper()
		var op documentedOperation
		if err := json.Unmarshal(spec.Paths[path][method], &op); err != nil {
			t.Fatal(err)
		}
		return op
	}
	// 下载、原文、资源代理与 OpenAPI 本身不使用业务 JSON 外壳。
	raw := map[string]bool{
		"get /openapi.json": true, "get /files/{path}": true, "get /raw/{path}": true,
		"get /plugins/{id}/assets/{revision}/{path}": true, "get /fonts/{id}/file": true,
		"get /resources/{ticket}/{kind}/{path}": true, "post /export": true,
		"post /maintenance/export/{kind}": true, "post /maintenance/notes/export": true,
		"post /maintenance/logs/export": true,
	}
	for path, methods := range spec.Paths {
		for method := range methods {
			if method == "parameters" {
				continue
			}
			for status, response := range operation(path, method).Responses {
				if !strings.HasPrefix(status, "2") || status == "204" || raw[method+" "+path] {
					continue
				}
				t.Run(method+" "+path+" "+status, func(t *testing.T) {
					body, ok := response.Content["application/json"]
					if !ok {
						t.Fatal("普通成功响应缺少 JSON 定义")
					}
					for _, key := range []string{"code", "data", "message"} {
						if !slices.Contains(body.Schema.Required, key) || body.Schema.Properties[key] == nil {
							t.Fatalf("响应未声明必填字段 %s", key)
						}
					}
					if string(body.Schema.Properties["code"].Const) != "0" {
						t.Fatal("成功业务码必须为 0")
					}
				})
			}
		}
	}
	for _, tc := range []struct {
		path     string
		statuses []string
	}{
		{"/fonts", []string{"200", "201"}},
		{"/maintenance/uploads", []string{"201"}},
		{"/maintenance/restore", []string{"202"}},
	} {
		var actual []string
		for status := range operation(tc.path, "post").Responses {
			if strings.HasPrefix(status, "2") {
				actual = append(actual, status)
			}
		}
		slices.Sort(actual)
		if !slices.Equal(actual, tc.statuses) {
			t.Errorf("POST %s 成功状态错误: %v", tc.path, actual)
		}
	}

	f := newFixture(t)
	check := func(method, path string, response *http.Response) {
		t.Helper()
		defer response.Body.Close()
		documented, ok := operation(path, method).Responses[strconv.Itoa(response.StatusCode)]
		if !ok || response.StatusCode >= 300 {
			t.Fatalf("%s %s 实际成功状态未正确声明: %d", method, path, response.StatusCode)
		}
		var body struct {
			Code int
			Data map[string]json.RawMessage
		}
		if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body.Code != 0 || body.Data == nil {
			t.Fatalf("实际响应不是成功 JSON: %+v", body)
		}
		schema := *documented.Content["application/json"].Schema.Properties["data"]
		if schema.Ref != "" {
			schema = spec.Components.Schemas[strings.TrimPrefix(schema.Ref, "#/components/schemas/")]
		}
		for key := range body.Data {
			if schema.Properties[key] == nil {
				t.Errorf("%s %s 未声明实际字段 data.%s", method, path, key)
			}
		}
		for _, key := range schema.Required {
			if _, ok := body.Data[key]; !ok {
				t.Errorf("%s %s 未返回文档必填字段 data.%s", method, path, key)
			}
		}
	}
	check("get", "/metadata", f.do(f.admin, "GET", "/api/v1/metadata", "", nil))
	check("get", "/fonts", f.do(f.admin, "GET", "/api/v1/fonts", "", nil))
	for range 2 {
		check("post", "/fonts", uploadTestFont(t, f, f.admin, "contract.woff2", testFontData(t)))
	}
	check("get", "/maintenance/status", f.do(f.admin, "GET", "/api/v1/maintenance/status", "", nil))
	check("post", "/maintenance/uploads", f.do(f.admin, "POST", "/api/v1/maintenance/uploads", `{"kind":"settings","size":10}`, nil))
	id := stagedPackage(t, f, "full", exportedPackage(t, f, "full"))
	// 仅验证提交契约；合成实例不触发真实进程重启或恢复执行。
	f.server.Restart = func() {}
	check("post", "/maintenance/restore", f.do(f.admin, "POST", "/api/v1/maintenance/restore", `{"id":"`+id+`","confirmed":true}`, nil))
}
