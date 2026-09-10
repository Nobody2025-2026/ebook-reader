// 从 CHANGELOG.md 抽取「给用户看」的发布说明（GitHub Release notes）。
//
// 用法：
//   node scripts/release-notes.mjs 0.1.2                 # 打印到 stdout
//   node scripts/release-notes.mjs 0.1.2 --out notes.md  # 写到文件（CI 用）
//   node scripts/release-notes.mjs                       # 版本取 $GITHUB_REF_NAME（自动去 v 前缀）
//   node scripts/release-notes.mjs 0.1.2 --strict        # 标题仍是「待发布」时直接失败
//   node scripts/release-notes.mjs 0.1.2 --no-hint       # 不追加桌面版安装提示
//
// 为什么需要它：GitHub 仓库页上直接展示的是 commit message，里面混着
// `docs:` / `chore:` / `test:` 这类**维护者视角**的记录（补日期、改文档、加测试）。
// 对用户来说那是噪音——用户只关心"我这个版本能多用什么、什么 bug 修好了"。
// 所以发版时用这个脚本从 CHANGELOG 抽出用户视角的章节，作为 Release notes。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 允许出现在发布说明里的小节。
 * 不在此名单的整段丢弃——尤其是「测试」「文档」「内部」「杂项」这类
 * 只有维护者才关心的小节（AGENTS.md 第 3 条：用户无感的改动不必写给用户）。
 * 数组顺序 = 输出顺序，保证「新增」永远排在「修复」前面。
 */
export const USER_SECTIONS = ['新增', '修复', '破坏性变更', '变更', '弃用', '移除', '安全']

// 发布说明末尾的固定提示：桌面版 dmg 未做代码签名，用户第一次打开会被 Gatekeeper 拦。
// 不写具体 App 名/路径，避免与 productName 改动脱节。
export const DESKTOP_HINT = [
  '---',
  '',
  '> **macOS 提示「无法打开」？** 本应用未做代码签名，属正常现象。',
  '> 到「系统设置 → 隐私与安全性」点「仍要打开」，或右键 App 选「打开」即可放行。',
].join('\n')

/** 去掉小节标题尾部的括号补充，如「修复（本轮：高亮实测回归）」→「修复」 */
function normalizeSectionTitle(raw) {
  return raw.replace(/[（(][\s\S]*$/, '').trim()
}

/**
 * 从 CHANGELOG 正文里抽出指定版本的「用户视角」发布说明。
 * @param {string} changelog CHANGELOG.md 全文
 * @param {string} version   版本号，允许带 v 前缀
 * @returns {{ body: string, version: string, pending: boolean, dropped: string[] }}
 */
export function extractReleaseNotes(changelog, version) {
  const wanted = String(version).trim().replace(/^v/, '')
  if (!wanted) throw new Error('缺少版本号')

  const lines = changelog.split('\n')
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const headerRe = new RegExp(`^##\\s+\\[${escaped}\\](.*)$`)

  const start = lines.findIndex((l) => headerRe.test(l))
  if (start === -1) {
    throw new Error(`CHANGELOG.md 里找不到版本 [${wanted}] 的条目，发版前请先补写`)
  }
  // 版本标题仍是「待发布」= 发布清单第 4 条的日期还没补
  const pending = /待发布/.test(lines[start])

  // 本章区间：到下一个 `## [` 为止
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+\[/.test(lines[i])) {
      end = i
      break
    }
  }

  // 按 `### ` 切小节
  const sections = []
  let cur = null
  for (const line of lines.slice(start + 1, end)) {
    const m = /^###\s+(.*\S)\s*$/.exec(line)
    if (m) {
      cur = { title: normalizeSectionTitle(m[1]), lines: [] }
      sections.push(cur)
    } else if (cur) {
      cur.lines.push(line)
    }
  }

  // 过滤内部小节 + 合并同名小节（CHANGELOG 里常按"轮次"拆成多个「新增」/「修复」）
  const merged = new Map()
  const dropped = []
  for (const s of sections) {
    const body = s.lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
    if (!body) continue
    if (!USER_SECTIONS.includes(s.title)) {
      if (!dropped.includes(s.title)) dropped.push(s.title)
      continue
    }
    merged.set(s.title, merged.has(s.title) ? `${merged.get(s.title)}\n\n${body}` : body)
  }

  const parts = []
  for (const title of USER_SECTIONS) {
    if (!merged.has(title)) continue
    parts.push(`### ${title}\n\n${merged.get(title)}`)
  }
  if (parts.length === 0) {
    throw new Error(
      `版本 [${wanted}] 没有任何用户可感知的改动（新增/修复/…），` +
        `检查 CHANGELOG.md 是否把小节标题写成了「测试」「文档」这类内部名字`,
    )
  }

  return { body: parts.join('\n\n'), version: wanted, pending, dropped }
}

/** 版本号：命令行参数优先，其次 CI 的 GITHUB_REF_NAME（tag 名，去 v 前缀） */
export function resolveVersion(argv = [], env = {}) {
  let skipNext = false
  for (const a of argv) {
    // --out 后面跟的是文件路径，别把它当版本号
    if (skipNext) {
      skipNext = false
      continue
    }
    if (a === '--out') {
      skipNext = true
      continue
    }
    if (a.startsWith('--')) continue
    return a.trim().replace(/^v/, '')
  }
  return (env.GITHUB_REF_NAME || '').trim().replace(/^v/, '')
}

function main() {
  const argv = process.argv.slice(2)
  const version = resolveVersion(argv, process.env)
  if (!version) {
    console.error('用法: node scripts/release-notes.mjs <版本号> [--out 文件] [--strict] [--no-hint]')
    console.error('（也可以不传版本号，改用环境变量 GITHUB_REF_NAME，如 CI 里打 tag 时）')
    process.exit(1)
  }

  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
  let result
  try {
    result = extractReleaseNotes(changelog, version)
  } catch (err) {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  }

  if (result.pending) {
    const msg = `版本 [${result.version}] 的标题还是「待发布」，发布清单第 4 条要求补上发布日期`
    if (argv.includes('--strict')) {
      console.error(`✗ ${msg}`)
      process.exit(1)
    }
    console.error(`⚠ ${msg}（本次仍继续）`)
  }
  if (result.dropped.length > 0) {
    console.error(`· 已剔除内部小节：${result.dropped.join(' / ')}`)
  }

  const body = argv.includes('--no-hint') ? result.body : `${result.body}\n\n${DESKTOP_HINT}\n`

  const outIdx = argv.indexOf('--out')
  if (outIdx !== -1) {
    const out = argv[outIdx + 1]
    if (!out) {
      console.error('✗ --out 后面要跟文件路径')
      process.exit(1)
    }
    const target = resolve(root, out)
    writeFileSync(target, body)
    console.error(`✓ 已写入 ${target}（${body.length} 字符）`)
  } else {
    process.stdout.write(body)
  }
}

// 只在被当作脚本直接执行时跑 CLI；被 import 进测试时不触发
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
