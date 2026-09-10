// @vitest-environment node
// 资源解析层：正文图片/CSS 的地址由我们自己从 zip 解出。
// Node 端没有 window，退化成 data URL —— 正好可以把字节解出来逐字节校验，
// 这是"正文图片一张都显示不出来"那个 P0 的回归防线。
import { zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createResourceIndex, sniffMime, toDataUrl } from '../src/lib/resources'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7, 6])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:res-0001</dc:identifier>
    <dc:title>资源测试书</dc:title>
  </metadata>
  <manifest>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style/main.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>`

function makeEpub(): Uint8Array {
  return zipSync(
    {
      mimetype: enc('application/epub+zip'),
      'META-INF/container.xml': enc(
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'OEBPS/content.opf': enc(OPF),
      'OEBPS/text/ch1.xhtml': enc('<html><body><p>hi</p></body></html>'),
      'OEBPS/style/main.css': enc('body{background:url(../img/bg.png)}'),
      'OEBPS/img/bg.png': PNG,
      'OEBPS/images/pic.png': PNG,
      'OEBPS/images/pic.jpg': JPEG,
    },
    { level: 0 },
  )
}

/** 把 data URL 还原成字节，用于比对 */
function fromDataUrl(url: string): Uint8Array {
  return Uint8Array.from(atob(url.split(',')[1]), (ch) => ch.charCodeAt(0))
}

describe('sniffMime', () => {
  it('按魔数认出常见图片格式（扩展名可能写错，不能只信扩展名）', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg')
    expect(sniffMime(PNG)).toBe('image/png')
    expect(sniffMime(enc('GIF89a...'))).toBe('image/gif')
    expect(sniffMime(enc('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('image/svg+xml')
  })

  it('认不出来时用调用方给的兜底值', () => {
    expect(sniffMime(enc('not an image at all'), 'image/jpeg')).toBe('image/jpeg')
    expect(sniffMime(enc('not an image at all'))).toBe('')
  })
})

describe('toDataUrl', () => {
  it('大字节也不会爆栈（分块转 base64）', () => {
    const big = new Uint8Array(300_000).fill(65)
    const url = toDataUrl(big, 'image/jpeg')
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(fromDataUrl(url).length).toBe(big.length)
  })
})

describe('createResourceIndex', () => {
  const index = createResourceIndex(makeEpub())
  const chapterHref = 'OEBPS/text/ch1.xhtml'

  it('把 <img src> 换成解出来的图片地址，字节与 zip 原图一致', () => {
    const html = '<p><img src="../images/pic.png" alt="图"/></p>'
    const out = index.inlineAssets(html, chapterHref)
    const src = out.match(/<img[^>]+src="([^"]+)"/i)?.[1]
    expect(src).toMatch(/^data:image\/png;base64,/)
    expect(fromDataUrl(src!)).toEqual(PNG)
  })

  it('SVG 的 <image xlink:href> 也照样替换（部分书整章插图都包在 SVG 里）', () => {
    const html = '<svg><image xlink:href="../images/pic.jpg" width="10" height="10"/></svg>'
    const out = index.inlineAssets(html, chapterHref)
    const href = out.match(/<image[^>]+xlink:href="([^"]+)"/i)?.[1]
    expect(href).toMatch(/^data:image\/jpeg;base64,/)
    expect(fromDataUrl(href!)).toEqual(JPEG)
  })

  it('已经是绝对地址或内嵌数据的不动手', () => {
    const html =
      '<img src="https://example.com/a.png"/><img src="data:image/gif;base64,AAAA"/><img src="blob:abc"/>'
    const out = index.inlineAssets(html, chapterHref)
    expect(out).toContain('https://example.com/a.png')
    expect(out).toContain('data:image/gif;base64,AAAA')
    expect(out).toContain('blob:abc')
  })

  it('zip 里找不到的图片原样保留（不让一张坏图毁掉整章）', () => {
    const html = '<img src="../images/not-there.png"/>'
    expect(index.inlineAssets(html, chapterHref)).toContain('../images/not-there.png')
  })

  it('外链 CSS 内联成 data URL，且里面的相对 url() 一并换成 data URL', () => {
    const html = '<link rel="stylesheet" href="../style/main.css"/>'
    const out = index.inlineAssets(html, chapterHref)
    const href = out.match(/<link[^>]+href="([^"]+)"/i)?.[1]
    expect(href).toMatch(/^data:text\/css;base64,/)
    const css = dec(fromDataUrl(href!))
    // url(../img/bg.png) 相对 CSS 所在目录解析，必须已被替换成 data URL
    expect(css).toContain('url("data:image/png;base64,')
    expect(css).not.toContain('../img/bg.png')
  })

  it('非 stylesheet 的 <link> 不动', () => {
    const html = '<link rel="icon" href="../images/pic.png"/>'
    expect(index.inlineAssets(html, chapterHref)).toContain('rel="icon"')
  })

  it('能直读 zip 里的原始章节 html', () => {
    expect(index.rawChapterHtml(chapterHref)).toContain('<p>hi</p>')
    expect(index.rawChapterHtml('OEBPS/text/nope.xhtml')).toBeUndefined()
  })

  it('revoke 之后不影响纯字符串处理（Node 端本来就是 data URL）', () => {
    index.revoke()
    expect(index.inlineAssets('<img src="../images/pic.png"/>', chapterHref)).toContain(
      'data:image/png;base64,',
    )
  })
})

describe('createResourceIndex 容错', () => {
  it('zip 解不开时退化成空实现，书照样能读（只是没图）', () => {
    const broken = createResourceIndex(enc('this is definitely not a zip'))
    const html = '<img src="../images/pic.png"/>'
    expect(broken.inlineAssets(html, 'a.xhtml')).toBe(html)
    expect(broken.rawChapterHtml('a.xhtml')).toBeUndefined()
    expect(() => broken.revoke()).not.toThrow()
  })
})
