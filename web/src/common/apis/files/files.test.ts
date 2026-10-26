// @vitest-environment happy-dom
import { getCaptchaApi, loginApi } from '@@/apis/auth'
import { importFontApi } from '@@/apis/fonts'
import { searchApi } from '@@/apis/search'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { pinia } from '@/pinia'
import { useUserStore } from '@/pinia/stores/user'
import { apiSuccess } from '../../../../tests/api-response'
import { exportFilesApi, importNotesApi, writeFileApi } from './index'

const user = useUserStore(pinia)
beforeEach(() => user.setToken('rms_api_fixture'))
afterEach(() => {
  vi.restoreAllMocks(); user.setToken('')
})
const json = (data: unknown) => new Response(JSON.stringify(apiSuccess(data)), { headers: { 'Content-Type': 'application/json' } })
it('aPI 返回完整 JSON 响应，验证码和登录使用真实请求体且不发送现有身份', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ captchaId: 'challenge', imageDataUrl: 'data:image/png;base64,test', expiresAt: '2030-01-01' })).mockResolvedValueOnce(json({ token: 'rms_new', expiresAt: '2030-01-01' }))
  const captcha = await getCaptchaApi({ replaceId: 'old' })
  expect(captcha.code).toBe(0); expect(captcha.data.captchaId).toBe('challenge')
  const fields = { password: 'fixture-password', captchaId: captcha.data.captchaId, captchaCode: '123456' }
  expect((await loginApi(fields)).data.token).toBe('rms_new')
  const requests = fetch.mock.calls.map(call => call[0] as Request)
  expect(requests.every(request => !request.headers.has('Authorization'))).toBe(true)
  expect(await requests[0]!.json()).toEqual({ replaceId: 'old' })
  expect(await requests[1]!.json()).toEqual(fields)
})
it('gET 使用 params 编码查询，保留 Bearer 和完整搜索响应', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ results: [] }))
  expect(await searchApi({ q: '笔记 & 示例' })).toEqual(apiSuccess({ results: [] }))
  const request = fetch.mock.calls[0]![0] as Request
  expect(new URL(request.url).searchParams.get('q')).toBe('笔记 & 示例')
  expect(request.headers.get('Authorization')).toBe('Bearer rms_api_fixture')
})
it('字体与笔记使用真实 multipart 文件，不被 JSON 请求头覆盖', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ id: 'font' })).mockResolvedValueOnce(json({ notes: 1, assets: 0, paths: ['fixture.md'], warnings: [] }))
  await importFontApi(new File(['font'], 'fixture.woff2'))
  await importNotesApi({ dir: 'folder', folder: '', files: [new File(['# 正文'], 'fixture.md')] })
  for (const [input] of fetch.mock.calls) expect((input as Request).headers.get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/)
  const body = await (fetch.mock.calls[1]![0] as Request).formData()
  expect(body.get('dir')).toBe('folder')
  expect(body.get('files')).toMatchObject({ name: 'fixture.md' })
})
it('版本写入保留 Markdown 原文、条件请求头与小文件卸载保存', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ rev: 'next' }))
  expect((await writeFileApi({ path: '目录/a.md', content: '# 原文', ifMatch: 'old', keepalive: true })).data.rev).toBe('next')
  const request = fetch.mock.calls[0]![0] as Request
  expect(request.url).toContain(encodeURIComponent('目录'))
  expect(request.headers.get('If-Match')).toBe('"old"')
  expect(request.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8')
  expect(fetch.mock.calls[0]![1]).toMatchObject({ keepalive: true })
  expect(await request.text()).toBe('# 原文')
  await writeFileApi({ path: 'new.md', content: '', ifMatch: '' })
  expect((fetch.mock.calls[1]![0] as Request).headers.get('If-None-Match')).toBe('*')
})
it('导出直接返回 Blob 与下载响应头，不模拟 Fetch Response', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ZIP', { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="fixture.zip"' } }))
  const response = await exportFilesApi({ paths: ['fixture.md'] })
  expect(response.data).toBeInstanceOf(Blob)
  expect(await response.data.text()).toBe('ZIP')
  expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="fixture.zip"')
})
