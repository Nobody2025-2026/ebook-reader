// 用真实 EPUB 探底：看看脏数据长什么样。
// 用法：node scripts/probe-real.mjs [epub 路径]
import { initEpubFile } from '@lingo-reader/epub-parser'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, '../books/涛动周期论.epub')

if (!existsSync(target)) {
  console.error('找不到文件：', target)
  process.exit(1)
}

// 资源落盘到系统临时目录：项目目录下删文件慢得离谱（单个 ~60ms），
// 这本书会落盘几百个文件，用默认目录收尾会卡 20 秒以上。
const saveDir = mkdtempSync(join(tmpdir(), 'reader-probe-'))

const t0 = Date.now()
const epub = await initEpubFile(target, saveDir)
console.log('=== 打开耗时 ===')
console.log(`${Date.now() - t0} ms`)
console.log(`文件大小：${(readFileSync(target).length / 1024 / 1024).toFixed(1)} MB`)

console.log('\n=== 元数据 ===')
const meta = epub.getMetadata()
console.log('title   :', JSON.stringify(meta.title))
console.log('language:', JSON.stringify(meta.language))
console.log('creator :', JSON.stringify(meta.creator))

console.log('\n=== 目录 TOC ===')
let toc = []
try {
  toc = epub.getToc()
} catch (e) {
  console.log('getToc() 抛错：', e.message)
}
console.log('顶层条目数：', toc.length)
console.log(JSON.stringify(toc.slice(0, 8), null, 2))

console.log('\n=== Spine（章节） ===')
const spine = epub.getSpine()
console.log('章节数：', spine.length)
console.log(JSON.stringify(spine.slice(0, 5), null, 2))

console.log('\n=== 抽样加载章节 ===')
const samples = spine.length > 1 ? [0, Math.floor(spine.length / 2), spine.length - 1] : [0]
for (const i of samples) {
  const item = spine[i]
  if (!item) continue
  const t = Date.now()
  try {
    const { html, css } = await epub.loadChapter(item.id)
    const text = html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim()
    console.log(`\n[${i}] id=${item.id}`)
    console.log(`    耗时 ${Date.now() - t} ms | html ${html.length} 字符 | 纯文本 ${text.length} 字 | css ${css?.length ?? 0} 个`)
    console.log(`    前 80 字：${text.slice(0, 80)}`)
    const imgCount = (html.match(/<img/gi) || []).length
    console.log(`    内嵌图片标签：${imgCount}`)
  } catch (e) {
    console.log(`\n[${i}] id=${item.id} 加载失败：${e.message}`)
  }
}

console.log('\n=== 封面 ===')
try {
  const cover = epub.getCoverImage()
  console.log('cover:', cover ? String(cover).slice(0, 100) : '(空)')
} catch (e) {
  console.log('getCoverImage() 抛错：', e.message)
}

epub.destroy()
rmSync(saveDir, { recursive: true, force: true })
console.log('\n探针结束')
