// 生成测试用 EPUB 样本：node scripts/build-fixture.mjs
// 输出 tests/fixtures/sample.epub（EPUB 3.0，两章 + 目录）
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outFile = resolve(root, 'tests/fixtures/sample.epub')

const chapter = (n, title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><meta charset="UTF-8" /><title>${title}</title><link rel="stylesheet" href="style.css" /></head>
<body><h1>${title}</h1>${body}</body>
</html>`

const files = {
  // mimetype 必须是第一个条目且不压缩
  mimetype: 'application/epub+zip',
  'META-INF/container.xml': `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  'OEBPS/content.opf': `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:test-sample-0001</dc:identifier>
    <dc:title>小喵子的测试书</dc:title>
    <dc:creator>主上大人</dc:creator>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`,
  'OEBPS/nav.xhtml': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8" /><title>目录</title></head>
<body><nav epub:type="toc"><ol>
  <li><a href="chapter1.xhtml">第一章 开场</a></li>
  <li><a href="chapter2.xhtml">第二章 收尾</a></li>
</ol></nav></body>
</html>`,
  'OEBPS/toc.ncx': `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:test-sample-0001"/></head>
  <docTitle><text>小喵子的测试书</text></docTitle>
  <navMap>
    <navPoint id="nav1" playOrder="1"><navLabel><text>第一章 开场</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="nav2" playOrder="2"><navLabel><text>第二章 收尾</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>`,
  'OEBPS/chapter1.xhtml': chapter(1, '第一章 开场', '<p>这是第一章的正文，用来验证解析层能不能把章节内容取出来。</p><p>第二段文字，顺便测试多段落渲染。</p>'),
  'OEBPS/chapter2.xhtml': chapter(2, '第二章 收尾', '<p>这是第二章的正文，用来验证目录顺序和多章加载。</p>'),
  'OEBPS/style.css': 'body{line-height:1.8}h1{font-size:1.4em}',
}

const entries = Object.entries(files).map(([name, content]) => [
  name,
  name === 'mimetype' ? [strToU8(content), { level: 0 }] : strToU8(content),
])

const zipped = zipSync(Object.fromEntries(entries), { level: 6 })
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, zipped)
console.log(`已生成 ${outFile} (${zipped.length} bytes)`)
