import { describe, it, expect } from 'vitest'
import { zipSync, unzipSync } from 'fflate'
import { fixEpubBytes } from '../src/lib/epub'

// 构造最小可用 EPUB：container.xml 指向 OPF，OPF 末尾挂一个 guide 片段。
// 真实样本里空 <guide></guide> 是合法 EPUB2 结构（calibre 转换产物常见），
// 但解析库 0.4.6 的 parseGuide() 见不到 <reference> 会直接抛错 → 整本书打不开。
function buildEpub(guideFragment: string): Uint8Array {
  const container =
    '<?xml version="1.0"?>' +
    '<container><rootfiles>' +
    '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>' +
    '</rootfiles></container>'
  const opf =
    '<?xml version="1.0"?>' +
    '<package xmlns="http://www.idpf.org/2007/opf">' +
    '<metadata></metadata><manifest></manifest><spine></spine>' +
    guideFragment +
    '</package>'
  return zipSync({
    'META-INF/container.xml': new TextEncoder().encode(container),
    'OEBPS/content.opf': new TextEncoder().encode(opf),
  })
}

function opfOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(unzipSync(bytes)['OEBPS/content.opf'])
}

describe('fixEpubBytes：导入前剥离空 <guide>', () => {
  it('剥离成对标 <guide></guide>', () => {
    const fixed = fixEpubBytes(buildEpub('<guide></guide>'))
    expect(fixed).toBeInstanceOf(Uint8Array)
    const opf = opfOf(fixed as Uint8Array)
    expect(opf).not.toMatch(/<guide\b[^>]*>\s*<\/guide\s*>/i)
    expect(opf).not.toMatch(/<guide\b[^>]*\/>/i)
  })

  it('剥离自闭合 <guide/>', () => {
    const fixed = fixEpubBytes(buildEpub('<guide/>'))
    expect(fixed).toBeInstanceOf(Uint8Array)
    const opf = opfOf(fixed as Uint8Array)
    expect(opf).not.toMatch(/<guide\b[^>]*>\s*<\/guide\s*>/i)
    expect(opf).not.toMatch(/<guide\b[^>]*\/>/i)
  })

  it('带内容的 <guide> 不动，返回 undefined', () => {
    const bytes = buildEpub('<guide><reference href="x" type="cover"/></guide>')
    expect(fixEpubBytes(bytes)).toBeUndefined()
  })

  it('完全没有 guide 时返回 undefined', () => {
    expect(fixEpubBytes(buildEpub(''))).toBeUndefined()
  })
})
