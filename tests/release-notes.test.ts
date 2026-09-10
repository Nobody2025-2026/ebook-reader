import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// scripts/*.mjs 是给 CI / 本地直接用 node 跑的 ESM 脚本，不在 tsconfig 的 include 里，
// 所以这里显式忽略类型检查（vitest 运行时能正常解析 .mjs）。
// @ts-ignore
import { extractReleaseNotes, resolveVersion } from '../scripts/release-notes.mjs'

const SAMPLE = `# 更新日志

## [0.2.0] — 2026-09-20

### 新增

- 功能甲

### 测试

- 内部测试记录，不该给用户看

### 新增（本轮：功能乙）

- 功能乙

### 修复（本轮：某 bug）

- 某个 bug 修好了

### 文档

- 改了 README，不该给用户看

## [0.1.9] — 2026-09-01

### 修复

- 老版本的修复，不该出现在 0.2.0 的说明里
`

describe('release-notes 抽取', () => {
  it('只保留用户视角小节，剔除「测试」「文档」', () => {
    const r = extractReleaseNotes(SAMPLE, '0.2.0')
    expect(r.body).toContain('功能甲')
    expect(r.body).toContain('功能乙')
    expect(r.body).toContain('某个 bug 修好了')
    expect(r.body).not.toContain('内部测试记录')
    expect(r.body).not.toContain('改了 README')
    expect(r.dropped).toEqual(['测试', '文档'])
  })

  it('多个同名小节合并成一节，标题里的括号补充被去掉', () => {
    const { body } = extractReleaseNotes(SAMPLE, '0.2.0')
    expect(body.match(/^### 新增$/gm)).toHaveLength(1)
    expect(body.match(/^### 修复$/gm)).toHaveLength(1)
    // 括号里的「本轮：…」不该出现在标题上
    expect(body).not.toContain('### 新增（本轮')
    expect(body).not.toContain('### 修复（本轮')
    // 合并后两段内容都还在，且「新增」排在「修复」之前
    expect(body.indexOf('### 新增')).toBeLessThan(body.indexOf('### 修复'))
  })

  it('只取目标版本，不串到相邻版本', () => {
    const { body } = extractReleaseNotes(SAMPLE, '0.2.0')
    expect(body).not.toContain('老版本的修复')

    const older = extractReleaseNotes(SAMPLE, '0.1.9')
    expect(older.body).toContain('老版本的修复')
    expect(older.body).not.toContain('功能甲')
  })

  it('版本号允许带 v 前缀', () => {
    expect(extractReleaseNotes(SAMPLE, 'v0.1.9').body).toContain('老版本的修复')
  })

  it('版本号是精确匹配，[0.2.0] 不会命中 [0.20.0]', () => {
    const tricky = SAMPLE.replace('## [0.2.0]', '## [0.20.0]')
    expect(() => extractReleaseNotes(tricky, '0.2.0')).toThrow(/找不到版本/)
    expect(extractReleaseNotes(tricky, '0.20.0').body).toContain('功能甲')
  })

  it('标题仍是「待发布」时标记 pending，补了日期则不是', () => {
    expect(extractReleaseNotes(SAMPLE, '0.2.0').pending).toBe(false)
    const pending = SAMPLE.replace('## [0.2.0] — 2026-09-20', '## [0.2.0] — 待发布')
    expect(extractReleaseNotes(pending, '0.2.0').pending).toBe(true)
  })

  it('找不到版本 / 全是内部小节时抛错', () => {
    expect(() => extractReleaseNotes(SAMPLE, '9.9.9')).toThrow(/找不到版本/)
    const internalOnly = `## [0.3.0] — 2026-09-21

### 测试

- 只有内部记录
`
    expect(() => extractReleaseNotes(internalOnly, '0.3.0')).toThrow(/没有任何用户可感知的改动/)
  })

  it('resolveVersion：命令行参数优先，其次 GITHUB_REF_NAME，都去 v 前缀', () => {
    expect(resolveVersion(['0.2.0'], { GITHUB_REF_NAME: 'v0.1.9' })).toBe('0.2.0')
    expect(resolveVersion([], { GITHUB_REF_NAME: 'v0.1.9' })).toBe('0.1.9')
    expect(resolveVersion([], {})).toBe('')
    // --out 这类选项不能被当成版本号
    expect(resolveVersion(['--out', 'x.md'], { GITHUB_REF_NAME: 'v0.1.9' })).toBe('0.1.9')
  })
})

describe('release-notes 对真实 CHANGELOG 的冒烟', () => {
  // 用 cwd 而不是 import.meta.url：vitest 转换后 import.meta.url 不是 file 协议
  const changelog = readFileSync(resolve(process.cwd(), 'CHANGELOG.md'), 'utf8')

  it('0.1.2 抽出的说明含用户可见内容，且不含测试文件名', () => {
    const { body, dropped } = extractReleaseNotes(changelog, '0.1.2')
    expect(body).toContain('自定义字体上传')
    expect(body).toContain('### 新增')
    expect(body).toContain('### 修复')
    // 维护者视角的记录必须被剔除
    expect(body).not.toMatch(/tests\//)
    expect(dropped).toContain('测试')
  })

  it('0.1.3 已补发布日期，抽出「新增 / 修复」且同名小节合并为一', () => {
    const r = extractReleaseNotes(changelog, '0.1.3')
    expect(r.pending).toBe(false) // 已发布：标题不再是「待发布」
    expect(r.body).toContain('阅读时长统计')
    expect(r.body).toContain('高亮')
    expect(r.body.match(/^### 新增$/gm)).toHaveLength(1)
    expect(r.body.match(/^### 修复$/gm)).toHaveLength(1)
    expect(r.body).not.toMatch(/tests\//)
  })
})
