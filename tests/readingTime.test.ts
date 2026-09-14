// @vitest-environment node
// 「本章剩余时间」估算：纯函数，不碰 DOM，跑得最快。
import { describe, expect, it } from 'vitest'
import { estimateChapterRemainMinutes, formatPercentLine, formatRemainText } from '../src/lib/readingTime'
import type { ContentRange } from '../src/lib/progress'

const rangeAll: ContentRange = { first: 0, last: 2 }

describe('estimateChapterRemainMinutes', () => {
  it('读得不足 1 分钟时不估（样本太小，估了只会误导）', () => {
    expect(
      estimateChapterRemainMinutes({
        weights: [10000, 10000, 10000],
        chapterIndex: 0,
        withinRatio: 0,
        contentRange: rangeAll,
        readSeconds: 30,
        percent: 5,
      }),
    ).toBeNull()
  })

  it('已读字数不足 2000 时不估', () => {
    expect(
      estimateChapterRemainMinutes({
        weights: [10000, 10000, 10000],
        chapterIndex: 0,
        withinRatio: 0,
        contentRange: rangeAll,
        readSeconds: 600,
        percent: 0.5, // 3 万字 × 0.5% = 150 字，太少
      }),
    ).toBeNull()
  })

  it('正常阅读：按已读时长倒推速度，给出本章剩余分钟', () => {
    // 全书 30000 字，10 分钟读到 30% → 已读 9000 字 → 900 字/分
    // 本章 10000 字、读到一半 → 剩 5000 字 → 5000 / 900 ≈ 5.6 → 6 分钟
    const minutes = estimateChapterRemainMinutes({
      weights: [10000, 10000, 10000],
      chapterIndex: 0,
      withinRatio: 0.5,
      contentRange: rangeAll,
      readSeconds: 600,
      percent: 30,
    })
    expect(minutes).toBe(6)
  })

  it('本章已读到尾返回 0，UI 才能说"本章读完"而不是继续显示 1 分钟', () => {
    expect(
      estimateChapterRemainMinutes({
        weights: [10000, 10000, 10000],
        chapterIndex: 0,
        withinRatio: 1,
        contentRange: rangeAll,
        readSeconds: 600,
        percent: 30,
      }),
    ).toBe(0)
  })

  it('速度被夹在合理区间：刚打开就拖到 90% 也算不出"0 分钟"', () => {
    // 不夹逼的话 rawSpeed ≈ 17.7 万字/分，剩 10 万字只需 0 分钟——荒谬
    const minutes = estimateChapterRemainMinutes({
      weights: [100000, 100000],
      chapterIndex: 1,
      withinRatio: 0,
      contentRange: { first: 0, last: 1 },
      readSeconds: 61,
      percent: 90,
    })
    expect(minutes).toBe(50) // 100000 / 2000（上限速度）
  })

  it('权重为 0（脏 EPUB / 解压失败）一律不估', () => {
    expect(
      estimateChapterRemainMinutes({
        weights: [0, 0, 0],
        chapterIndex: 0,
        withinRatio: 0,
        contentRange: rangeAll,
        readSeconds: 600,
        percent: 50,
      }),
    ).toBeNull()
  })

  it('章节序号越界不炸', () => {
    expect(
      estimateChapterRemainMinutes({
        weights: [10000, 10000, 10000],
        chapterIndex: 99,
        withinRatio: 0,
        contentRange: rangeAll,
        readSeconds: 600,
        percent: 50,
      }),
    ).toBeNull()
  })
})

describe('formatRemainText', () => {
  it('null → 估算中；0 → 本章读完；分钟 / 小时各有格式', () => {
    expect(formatRemainText(null)).toBe('剩余时间估算中')
    expect(formatRemainText(0)).toBe('本章读完')
    expect(formatRemainText(12)).toBe('剩约 12 分')
    expect(formatRemainText(60)).toBe('剩 1 小时')
    expect(formatRemainText(75)).toBe('剩 1 时 15 分')
  })
})

// v0.1.6：剩余时间从"点百分比才切出来"改成**常驻**跟在百分比后面。
describe('formatPercentLine', () => {
  it('能估算时：百分比 + 剩余时间并排', () => {
    expect(formatPercentLine(62.34, 12)).toBe('62.3% · 剩约 12 分')
    expect(formatPercentLine(100, 0)).toBe('100.0% · 本章读完')
    expect(formatPercentLine(30, 75)).toBe('30.0% · 剩 1 时 15 分')
  })

  it('估不出来时只给百分比，不写"估算中"这种半截话', () => {
    expect(formatPercentLine(0, null)).toBe('0.0%')
    expect(formatPercentLine(62.34, null)).toBe('62.3%')
    expect(formatPercentLine(62.34, null)).not.toContain('估算')
  })
})
