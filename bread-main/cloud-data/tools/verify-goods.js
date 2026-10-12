#!/usr/bin/env node
/**
 * 已录入商品的验收核对（真实数据落库前的最后一道关）
 * ---------------------------------------------------------------------------
 * build-goods.js 管的是「源文件 → jsonl 的格式与价格换算」；
 * 本脚本管的是「生成物放进小程序后，客户实际看到什么」——
 * 它直接调用**云函数里真实的计价与配送逻辑**，不用替身、不复制一份逻辑，
 * 因此能抓出「数据看着对、但页面算错」的问题：
 *
 *   1) categoryId 是否真在 category 集合里（写错 → 商品从列表消失，且不报错）
 *   2) minPrice 是否等于最便宜那个规格组合的实际价（用真实 calcPrice 验算）
 *   3) 详情富文本用的标签是否都在 parser 组件的白名单里（否则标签被丢掉、排版错乱）
 *   4) 图片路径在工程里是否真的存在
 *   5) isCake / 蛋糕尺寸能不能被配送规则识别（决定「3公里内免配送费」与「蛋糕提前3小时」）
 *
 * 用法：node cloud-data/tools/verify-goods.js
 * ---------------------------------------------------------------------------
 */
'use strict'

const fs = require('fs')
const path = require('path')

const CD = path.resolve(__dirname, '..') // bread-main/cloud-data
const ROOT = path.resolve(CD, '..') // bread-main

const GOODS = path.join(CD, 'goods-real.jsonl')
const CATEGORIES = path.join(CD, 'categories.jsonl')

const { calcPrice } = require(path.join(ROOT, 'cloudfunctions/api/handlers'))
const { isCakeGoods, parseCakeSizeInch } = require(path.join(ROOT, 'cloudfunctions/api/delivery-calc'))

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log('  OK   ' + name)
  } else {
    fail++
    console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : ''))
  }
}

function readJsonl(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

// ---- parser 组件允许的标签白名单（从组件源码里读，避免我凭印象写）----
function parserTrustTags() {
  const src = fs.readFileSync(
    path.join(ROOT, 'components/parser.20200414.min/libs/config.js'),
    'utf8'
  )
  const m = src.match(/trustTags=makeMap\("([^"]+)"\)/)
  if (!m) return null
  return m[1].split(',')
}

function main() {
  if (!fs.existsSync(GOODS)) {
    console.error('找不到 ' + path.relative(process.cwd(), GOODS) + '，先跑 build-goods.js')
    process.exit(1)
  }

  const goods = readJsonl(GOODS)
  const catIds = readJsonl(CATEGORIES).map((c) => c._id)
  const catName = {}
  readJsonl(CATEGORIES).forEach((c) => (catName[c._id] = c.name))
  const tags = parserTrustTags()

  console.log('\n已录入商品验收核对（源：' + path.relative(process.cwd(), GOODS) + '，共 ' + goods.length + ' 个）')
  console.log('═'.repeat(74))

  goods.forEach((g) => {
    console.log('\n▌' + g.name + '   [' + (catName[g.categoryId] || g.categoryId) + ']')

    // 1) 分类
    check('分类 id 存在于 category 集合', catIds.indexOf(g.categoryId) >= 0, g.categoryId)

    // 2) 图片
    const pics = (g.pics || []).map((p) => (typeof p === 'string' ? p : p.pic))
    check('至少 1 张轮播图', pics.length >= 1, pics)
    pics.forEach((p) => {
      if (/^(https?:|cloud:)/i.test(p)) return // 外链/云存储无法在本地校验
      check('图片文件存在 ' + p, fs.existsSync(path.join(ROOT, p.replace(/^\//, ''))), p)
    })
    check('列表缩略图 pic = 第一张轮播图', g.pic === pics[0], { pic: g.pic, first: pics[0] })
    // 托管方式必须统一：混用会导致一部分图 404（且只在真机上暴露）
    const cloudPics = pics.filter((p) => /^cloud:/i.test(p))
    const localPics = pics.filter((p) => !/^(https?:|cloud:)/i.test(p))
    check(
      '图片托管方式一致（不混用本地路径与 cloud://）',
      !(cloudPics.length && localPics.length),
      { cloud: cloudPics, local: localPics }
    )

    // 3) 必填字段
    check('有商品名', typeof g.name === 'string' && g.name.trim() !== '')
    check('minPrice 是正数', typeof g.minPrice === 'number' && g.minPrice > 0, g.minPrice)
    check('enabled 已上架', g.enabled !== false)

    // 4) 详情富文本标签是否会被 parser 渲染
    if (g.content) {
      const used = Array.from(new Set((g.content.match(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g) || []).map((s) => s.replace(/[</]/g, '').toLowerCase())))
      const unknown = used.filter((t) => tags && tags.indexOf(t) < 0)
      check('详情富文本标签全部受支持 (' + used.join(',') + ')', unknown.length === 0, unknown)
    }

    // 5) 真实计价逻辑验算：最便宜组合 = minPrice
    const groups = g.properties || []
    if (groups.length) {
      // 每个规格组选 priceDelta 最小的选项 = 理论最低价
      const cheapest = groups.map((grp) => {
        const opts = grp.childsCurGoods || []
        return opts.reduce((a, b) => ((b.priceDelta || 0) < (a.priceDelta || 0) ? b : a), opts[0])
      })
      const sku = groups.map((grp, i) => ({ optionId: grp.id, optionValueId: cheapest[i].id }))
      const lowest = calcPrice(g, sku)
      check(
        '最便宜规格组合的实际价 = minPrice (' + lowest + ')',
        Math.abs(lowest - g.minPrice) < 0.01,
        { minPrice: g.minPrice, 实算: lowest }
      )

      // 最贵组合，供店主核对价目表
      const dearest = groups.map((grp) => {
        const opts = grp.childsCurGoods || []
        return opts.reduce((a, b) => ((b.priceDelta || 0) > (a.priceDelta || 0) ? b : a), opts[0])
      })
      const skuMax = groups.map((grp, i) => ({ optionId: grp.id, optionValueId: dearest[i].id }))
      const highest = calcPrice(g, skuMax)
      const detail = groups
        .map((grp, i) => grp.childsCurGoods.map((o) => o.name + (o.priceDelta ? (o.priceDelta > 0 ? '+' : '') + o.priceDelta : '')).join('/'))
        .join('  ')
      console.log(
        '       ↳ 价目：￥' + lowest + ' ~ ￥' + highest + '   [' + detail + ']'
      )
      check('每个规格组的选项都非空', groups.every((grp) => (grp.childsCurGoods || []).length > 0))
      check('规格组 id 唯一', new Set(groups.map((x) => x.id)).size === groups.length)
    } else {
      check('无规格商品 minPrice 即售价', g.minPrice > 0)
      console.log('       ↳ 价目：￥' + g.minPrice + '（无规格）')
    }

    // 6) 配送规则识别
    const isCake = isCakeGoods(g)
    const inch = parseCakeSizeInch(g, null)
    console.log(
      '       ↳ 配送规则：isCake=' + isCake + '，识别尺寸=' + (inch === null ? '无' : inch + '寸') +
        (isCake ? '，需提前3小时' : '') +
        (inch !== null && inch >= 6 ? '，3公里内免配送费' : '')
    )
    check('蛋糕类商品能被 isCake 识别', g.isCake !== true || isCake === true)
  })

  console.log('\n' + '═'.repeat(74))
  console.log((fail === 0 ? '全部通过：' : '存在失败：') + pass + ' 通过 / ' + fail + ' 失败')
  process.exit(fail === 0 ? 0 : 1)
}

main()
