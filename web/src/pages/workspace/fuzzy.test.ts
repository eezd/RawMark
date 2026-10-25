import { describe, expect, it } from 'vitest'
import { fuzzyMatch } from './fuzzy'

const match = (q: string, path: string) => fuzzyMatch(q, path, path.lastIndexOf('/') + 1)
function rank(q: string, paths: string[]) {
  return paths
    .map(p => ({ p, m: match(q, p) }))
    .filter(x => x.m)
    .sort((a, b) => b.m!.score - a.m!.score)
    .map(x => x.p)
}

describe('fuzzyMatch', () => {
  it('不区分大小写，记录命中位置', () => {
    expect(match('READ', 'docs/readme')?.positions).toEqual([5, 6, 7, 8])
  })

  it('按顺序零散命中，顺序不对则不匹配', () => {
    expect(match('dpl', 'deploy')?.positions).toEqual([0, 2, 3])
    expect(match('lpd', 'deploy')).toBeNull()
  })

  it('多个词都要命中，可分别落在目录和标题', () => {
    expect(match('项目 部署', '项目/部署笔记')).not.toBeNull()
    expect(match('项目 发布', '项目/部署笔记')).toBeNull()
  })

  it('标题完全一致 > 标题开头 > 标题中间 > 目录 > 零散命中', () => {
    expect(rank('部署', ['部署/其他', '笔记/安装部署', '部署说明', '部 x 署', '部署'])).toEqual(['部署', '部署说明', '笔记/安装部署', '部署/其他', '部 x 署'])
  })

  it('零散命中时紧凑、命中词首的排前', () => {
    expect(rank('rm', ['rawmark', 'readme', 'r-m'])[0]).toBe('r-m')
  })
})
