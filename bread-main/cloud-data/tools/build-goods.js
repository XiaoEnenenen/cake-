#!/usr/bin/env node
/**
 * 真实商品录入工具
 * ---------------------------------------------------------------------------
 *   goods-real.source.json   （人写的源文件，字段友好：分类写名字、尺寸写绝对价）
 *            │  node cloud-data/tools/build-goods.js
 *            ▼
 *   goods-real.jsonl         （微信云开发控制台「导入」用的格式，每行一条）
 *
 * 为什么要有这一步，而不直接手写 jsonl：
 *   1) categoryId 必须是 category 集合里真实存在的 _id（写错 → 商品在分类下不显示，且不报错）；
 *   2) properties 里生效的是 priceDelta（加价），不是绝对价 —— 手写极容易把 6寸 128 直接写成
 *      priceDelta:128，结果最终价变成 minPrice+128（本店算法：最终价 = minPrice + 各选中项加价之和，
 *      见 cloudfunctions/api/handlers.js 的 calcPrice / getDelta）；
 *   3) pics 有两种历史写法（["url"] 与 [{pic:"url"}]），统一成 [{pic}] 与线上种子一致；
 *   4) 图片文件缺没缺、id 有没有重复、价格有没有算错，都能在这里一次性查出来。
 *
 * 规格怎么表达（三者可以同时用）：
 *   sizes       基础规格，**写绝对价**（如 6寸 178 / 8寸 238）→ 决定 minPrice，其余选项自动转成加价
 *   flavors     口味，**写加价**（如 巧克力 +10）
 *   specGroups  任意多组"加价型"规格（阶段 9 第 1 步新增）：
 *               夹心一 / 夹心二 / 奶油类型 / 装饰…每组单选，选项写 delta（加价，缺省 0）
 *               ⚠️ 磅数这类"绝对价"规格仍然只能用 sizes 写（否则 minPrice 无法确定，工具会报错）
 *   三处组名/组 id 不能重复；组内选项 id 由名字稳定生成（芒果 → f_mango、6寸 → s6）。
 *
 * 用法：
 *   node cloud-data/tools/build-goods.js            # 校验 + 生成 goods-real.jsonl
 *   node cloud-data/tools/build-goods.js --check    # 只校验，不写文件
 *
 * 测试：tests/test-build-goods.js 直接调用本文件导出的 buildRecords()（纯函数，不碰磁盘），
 *      并断言"当前的 goods-real.jsonl == 源文件重新生成的结果"（改了源文件忘了跑脚本会红）。
 * ---------------------------------------------------------------------------
 */
'use strict'

const fs = require('fs')
const path = require('path')

const CD = path.resolve(__dirname, '..') // bread-main/cloud-data
const ROOT = path.resolve(CD, '..') // bread-main
const SRC = path.join(CD, 'goods-real.source.json')
const OUT = path.join(CD, 'goods-real.jsonl')
const CATEGORIES = path.join(CD, 'categories.jsonl')
const IMG_DIR = path.join(ROOT, 'images', 'goods')
const FALLBACK_PIC = '/images/logo@2x.png'
// 默认：图片打进小程序包（开发期用）。改成云存储见 toPics 注释与 tools/README.md
const LOCAL_IMAGE_BASE = '/images/goods/'
const isCloudBase = (b) => /^cloud:/i.test(String(b || ''))

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function readJsonl(file, err) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => {
      try {
        return JSON.parse(l)
      } catch (e) {
        err(path.basename(file) + ' 第 ' + (i + 1) + ' 行不是合法 JSON：' + e.message)
        return null
      }
    })
    .filter(Boolean)
}

/** 确定性短哈希：只依赖名字，插入/删除其它商品不会改变已有 id */
function shortHash(s) {
  let h = 2166136261
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36).slice(0, 6)
}

/** 常见口味 → 可读的选项 id（与线上种子 f_strawberry / f_chocolate 同一套命名） */
const FLAVOR_IDS = {
  原味: 'original', 巧克力: 'chocolate', 草莓: 'strawberry', 芒果: 'mango', 抹茶: 'matcha',
  榴莲: 'durian', 芋泥: 'taro', 蓝莓: 'blueberry', 奥利奥: 'oreo', 咖啡: 'coffee',
  香草: 'vanilla', 百香果: 'passionfruit', 提拉米苏: 'tiramisu', 荔枝: 'lychee',
  水蜜桃: 'peach', 桃子: 'peach', 柠檬: 'lemon', 栗子: 'chestnut', 榛果: 'hazelnut',
  酸奶: 'yogurt', 焦糖: 'caramel', 芝士: 'cheese', 海盐: 'seasalt', 玫瑰: 'rose',
  桂花: 'osmanthus', 红豆: 'redbean', 椰香: 'coconut', 椰子: 'coconut', 香蕉: 'banana',
  车厘子: 'cherry', 樱桃: 'cherry', 青提: 'grape', 葡萄: 'grape', 猕猴桃: 'kiwi',
  火龙果: 'dragonfruit', 无花果: 'fig', 开心果: 'pistachio', 栗蓉: 'chestnutpaste',
  // 夹心/奶油类常见选项（阶段 9：夹心一/夹心二/奶油类型 都能命中，得到可读 id）
  动物奶油: 'freshcream', 淡奶油: 'lightcream', 老奶油: 'oldcream', 植物奶油: 'vegfreshcream',
  进口动物奶油: 'importedcream', 布丁: 'pudding', 果冻: 'jelly', 莓果: 'berry',
  混合水果: 'mixedfruit', 黄桃: 'peachcan', 凤梨: 'pineapple', 咸奶油: 'saltedcream',
  芝士奶油: 'creamcheese', 巧克力脆珠: 'choccrunch'
}

/** 尺寸/口味选项 id：显式 id > 口味词典 > 名字里的数字（6寸→s6）> 短哈希 */
function optionId(prefix, name, explicit) {
  if (explicit) return String(explicit)
  if (prefix === 'f' && FLAVOR_IDS[name]) return 'f_' + FLAVOR_IDS[name]
  const digits = String(name).match(/\d+/g)
  if (digits && digits.length) return prefix + digits.join('')
  return prefix + '_' + shortHash(name)
}

/**
 * 规格组名 → 稳定的组 id（沿用线上种子的 'size' / 'flavor' 命名）
 * 组 id 会写进购物车 key 与订单快照，**必须稳定**：同一组名永远得到同一个 id。
 */
const GROUP_IDS = {
  磅数: 'size', 尺寸: 'size', 大小: 'size', 份量: 'size',
  口味: 'flavor', 味道: 'flavor',
  夹心: 'filling', 夹心一: 'filling1', 夹心二: 'filling2',
  奶油类型: 'cream', 奶油: 'cream',
  装饰: 'decoration', 插件: 'decoration', 生日插件: 'decoration',
  蜡烛: 'candle', 包装: 'packing', 甜度: 'sweetness'
} // 未命中的组名 → spec_<短哈希>

/** 规格组 id：显式 id > 组名词典 > spec_<短哈希> */
function groupId(name, explicit) {
  if (explicit) return String(explicit)
  const n = String(name).trim()
  if (GROUP_IDS[n]) return GROUP_IDS[n]
  return 'spec_' + shortHash(n)
}

/** 纯文本详情 → 富文本 HTML；已经是 HTML 就原样保留 */
function toHtml(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s) return ''
  // 只有「以标签开头」才当成已格式化 HTML —— 不能用「包含 <...>」判断：
  // 详情文字里正常写 "<p>" 三个字也会被误判，于是整段不转义直接塞进 parser
  if (/^<[a-z!/]/i.test(s)) return s
  return s
    .split(/\n\s*\n/)
    .map((p) => '<p>' + p.trim().replace(/\n/g, '<br/>') + '</p>')
    .join('')
}

/**
 * 图片字段 → 详情页轮播用的 pics 数组（统一 [{pic}] 写法）
 *
 * @param images 源文件里的文件名数组
 * @param imageBase 图片前缀（见源文件顶层 imageBase）：
 *   - 不写（默认）= '/images/goods/'  → 图片打进小程序包，受主包 2MB 限制，改图要重新提审
 *   - 'cloud://<环境ID>.<bucket>/goods/' → 图片放云存储，不受主包限制，改图不用重新提审
 *   两种模式切换只需改源文件里那一行，商品条目一个字都不用动。
 * @param warn 警告收集函数（由调用方注入，便于测试）
 */
function toPics(images, imageBase, warn) {
  const base = imageBase || LOCAL_IMAGE_BASE
  const isLocal = base.charAt(0) === '/'
  const list = (Array.isArray(images) ? images : images ? [images] : [])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean)
  if (!list.length) return [{ pic: FALLBACK_PIC }]
  return list.map((v) => {
    // 完整外链 / 云存储 fileID / 已带路径的，原样使用
    if (/^(https?:|cloud:|wxfile:|\/)/i.test(v)) return { pic: v }
    // 只写文件名 → 拼上当前托管方式的前缀
    if (isLocal) {
      const abs = path.join(IMG_DIR, v)
      if (!fs.existsSync(abs)) {
        warn('图片不存在：images/goods/' + v + '（导入后该图会 404，先补图再重跑）')
      }
    }
    return { pic: base.replace(/\/?$/, '/') + v }
  })
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN
}
const money = (n) => Math.round(n * 100) / 100

// ---------------------------------------------------------------------------
// 源文件 → 云端记录（纯函数：不读磁盘、不写文件，错误/警告通过注入的收集器返回）
// ---------------------------------------------------------------------------
/**
 * @param {Array} list 源文件的 goods 数组
 * @param {object} ctx { catByName, catById, imageBase, err, warn }
 * @returns {{ records: Array }}
 */
function buildRecords(list, ctx) {
  const catByName = ctx.catByName || {}
  const catById = ctx.catById || {}
  const imageBase = ctx.imageBase || ''
  const err = ctx.err || (() => {})
  const warn = ctx.warn || (() => {})

  const records = []
  const seenIds = {}

  list.forEach((g, i) => {
    const at = '第 ' + (i + 1) + ' 个商品' + (g && g.name ? '「' + g.name + '」' : '')
    if (!g || typeof g !== 'object') return err(at + '：不是对象')
    if (!g.name || !String(g.name).trim()) return err(at + '：缺少 name')

    const name = String(g.name).trim()

    // id
    const id = g.id
      ? String(g.id).trim()
      : 'g_real_' + shortHash(name)
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      err(at + '：id「' + id + '」只能包含字母/数字/下划线/中划线')
    }
    if (seenIds[id]) err(at + '：id 与「' + seenIds[id] + '」重复（' + id + '）')
    seenIds[id] = name

    // 分类：接受分类名，也接受 cat_ 开头的 _id
    let categoryId = ''
    const cRaw = g.category == null ? '' : String(g.category).trim()
    if (!cRaw) {
      err(at + '：缺少 category（所属分类）')
    } else if (catById[cRaw]) {
      categoryId = cRaw
    } else if (catByName[cRaw]) {
      categoryId = catByName[cRaw]
    } else {
      err(
        at +
          '：分类「' +
          cRaw +
          '」不在 categories.jsonl 里。可选：' +
          Object.keys(catByName).join(' / ')
      )
    }

    // 规格：sizes = 绝对价（如 6寸 128），flavors = 加价
    const sizes = Array.isArray(g.sizes) ? g.sizes.filter(Boolean) : []
    const flavors = Array.isArray(g.flavors) ? g.flavors.filter(Boolean) : []

    let minPrice = NaN
    const sizeOpts = []

    if (sizes.length) {
      const prices = []
      const seenSizeNames = {}
      sizes.forEach((s, si) => {
        const sname = s && s.name != null ? String(s.name).trim() : ''
        const price = num(s && s.price)
        const sat = at + ' 的第 ' + (si + 1) + ' 个尺寸'
        if (!sname) return err(sat + '：缺少 name')
        if (seenSizeNames[sname]) err(sat + '：尺寸名「' + sname + '」重复')
        seenSizeNames[sname] = 1
        if (!(price > 0)) return err(sat + '（' + sname + '）：price 必须是大于 0 的数字')
        prices.push(price)
        sizeOpts.push({ name: sname, price, id: optionId('s', sname, s.id) })
      })
      minPrice = money(Math.min.apply(null, prices))
      // priceDelta = 该规格绝对价 - 最低价（最低价那个选项加价为 0）
      sizeOpts.forEach((o) => {
        o.priceDelta = money(o.price - minPrice)
      })
    }

    if (!sizes.length) {
      const p = num(g.price)
      if (!(p > 0)) {
        err(at + '：既没有 sizes（磅数规格），也没有 price —— 至少给一个单价')
      } else {
        minPrice = money(p)
      }
    }

    const flavorOpts = flavors.map((f, fi) => {
      const fname = f && f.name != null ? String(f.name).trim() : ''
      const fat = at + ' 的第 ' + (fi + 1) + ' 个口味'
      if (!fname) {
        err(fat + '：缺少 name')
        return null
      }
      const delta = f.delta == null ? 0 : num(f.delta)
      if (!Number.isFinite(delta)) {
        err(fat + '（' + fname + '）：delta 必须是数字')
        return null
      }
      if (delta < 0) warn(at + '：口味「' + fname + '」是负加价（' + delta + '），确认是有意为之')
      return { id: optionId('f', fname, f.id), name: fname, priceDelta: money(delta) }
    })
    const flavorOk = flavorOpts.filter(Boolean)

    // ---- 任意多组"加价型"规格（阶段 9 第 1 步）----
    // specGroups: [{ id?, name, options: [{ id?, name, delta? }] }]
    //   组内单选、每组必选（服务端 resolveOrderSku 就是这么校验的）；
    //   选项 delta 是加价，基础价仍由 sizes / price 决定。
    if (g.specGroups !== undefined && !Array.isArray(g.specGroups)) {
      err(at + '：specGroups 必须是数组')
    }
    const specGroups = Array.isArray(g.specGroups) ? g.specGroups.filter(Boolean) : []
    const customGroups = []
    specGroups.forEach((grp, gi) => {
      const gat = at + ' 的第 ' + (gi + 1) + ' 个规格组'
      if (!grp || typeof grp !== 'object') return err(gat + '：不是对象')
      const gname = grp.name != null ? String(grp.name).trim() : ''
      if (!gname) return err(gat + '：缺少 name（组名，如"夹心一"）')
      const gid = groupId(gname, grp.id)
      if (gid === 'size') {
        return err(
          gat + '「' + gname + '」：绝对价的规格（磅数/尺寸）请用顶层 sizes 写 —— ' +
            'specGroups 只能写"加价"型规格（夹心、奶油类型…），否则 minPrice 算不出来'
        )
      }
      const opts = Array.isArray(grp.options) ? grp.options.filter(Boolean) : []
      if (!opts.length) return err(gat + '「' + gname + '」：options 不能为空（至少一个选项）')
      const built = []
      opts.forEach((o, oi) => {
        const oat = gat + '「' + gname + '」的第 ' + (oi + 1) + ' 个选项'
        if (!o || typeof o !== 'object') return err(oat + '：不是对象')
        const oname = o.name != null ? String(o.name).trim() : ''
        if (!oname) return err(oat + '：缺少 name')
        const delta = o.delta == null ? 0 : num(o.delta)
        if (!Number.isFinite(delta)) return err(oat + '（' + oname + '）：delta 必须是数字')
        if (delta < 0) {
          warn(at + '：「' + gname + '」的选项「' + oname + '」是负加价（' + delta + '），确认是有意为之')
        }
        built.push({ id: optionId('f', oname, o.id), name: oname, priceDelta: money(delta) })
      })
      customGroups.push({ id: gid, name: gname, childsCurGoods: built })
    })

    // 规格组（顺序：尺寸 → 口味 → 自定义组）
    const properties = []
    if (sizeOpts.length) {
      properties.push({
        id: 'size',
        name: g.sizeGroupName ? String(g.sizeGroupName) : '磅数',
        childsCurGoods: sizeOpts.map((o) => ({ id: o.id, name: o.name, priceDelta: o.priceDelta }))
      })
    }
    if (flavorOk.length) {
      properties.push({ id: 'flavor', name: '口味', childsCurGoods: flavorOk })
    }
    customGroups.forEach((grp) => properties.push(grp))

    // 组名 / 组 id / 组内选项 id 的唯一性
    // （组内选项 id 只要求组内唯一：不同组里都叫「芒果」是可以的，购物车 key 用的是"组:选项"对）
    const seenGroupNames = {}
    const seenGroupIds = {}
    properties.forEach((grp) => {
      if (seenGroupNames[grp.name]) {
        err(at + '：规格组名「' + grp.name + '」重复（sizes / flavors / specGroups 之间重名了）')
      }
      seenGroupNames[grp.name] = 1
      if (seenGroupIds[grp.id]) err(at + '：规格组 id「' + grp.id + '」重复')
      seenGroupIds[grp.id] = 1
      const seen = {}
      grp.childsCurGoods.forEach((o) => {
        if (seen[o.id]) err(at + '：' + grp.name + ' 的选项 id「' + o.id + '」重复（选项名重名？）')
        seen[o.id] = 1
      })
    })

    const pics = toPics(g.images || g.pics, imageBase, warn)
    // 有「磅数」规格 = 蛋糕（配送规则据此算免配送费/提前 3 小时，见 handlers.js 的 isCakeGoods）
    const isCake = typeof g.isCake === 'boolean' ? g.isCake : sizeOpts.length > 0

    // ---- 阶段 9：渠道差价 / 打包费 / 最少购买（都可选，默认关闭 = 不写字段）----
    //   pickupDiscount 自取立减（元/件）—— 对应美团「外送 178 / 自取 168」
    //   packingFee     打包费（元/件）  —— 对应美团「打包费 已设置(2)」
    //   minBuyNumber   最少购买份数     —— 对应美团「最少购买 1 份」
    // 都不写时**不生成这些字段**，生成的记录与加这三个能力之前逐字节一致。
    let pickupDiscount = 0
    let packingFee = 0
    let minBuyNumber = 1
    if (g.pickupDiscount !== undefined) {
      const v = num(g.pickupDiscount)
      if (!(v >= 0)) err(at + '：pickupDiscount 必须是 ≥ 0 的数字（自取立减，元/件）')
      else {
        pickupDiscount = money(v)
        if (Number.isFinite(minPrice) && pickupDiscount >= minPrice) {
          warn(
            at + '：pickupDiscount（' + pickupDiscount + '）≥ 最低价（' + minPrice +
              '），自取价会被算成 0，确认是有意为之'
          )
        }
      }
    }
    if (g.packingFee !== undefined) {
      const v = num(g.packingFee)
      if (!(v >= 0)) err(at + '：packingFee 必须是 ≥ 0 的数字（打包费，元/件）')
      else {
        packingFee = money(v)
        if (packingFee > 50) warn(at + '：packingFee（' + packingFee + ' 元/件）偏高，确认单位没写错（是"元"不是"分"）')
      }
    }
    if (g.minBuyNumber !== undefined) {
      const v = num(g.minBuyNumber)
      if (!Number.isInteger(v) || v < 1) {
        err(at + '：minBuyNumber 必须是不小于 1 的整数（最少购买份数）')
      } else {
        minBuyNumber = v
      }
    }

    const record = {
      _id: id,
      categoryId,
      name,
      pic: pics[0].pic,
      pics,
      characteristic: g.characteristic ? String(g.characteristic).trim() : '',
      content: toHtml(g.content || g.detail || ''),
      minPrice: Number.isFinite(minPrice) ? minPrice : 0,
      unit: g.unit ? String(g.unit) : '个',
      purchaseNotes: g.purchaseNotes ? String(g.purchaseNotes).trim() : '',
      sort: Number.isFinite(num(g.sort)) ? num(g.sort) : 10,
      enabled: g.enabled === false ? false : true,
      isCake: !!isCake,
      properties
    }
    // 只在"确实启用"时才写字段（0 / 1 视为未启用，不污染数据）
    if (pickupDiscount > 0) record.pickupDiscount = pickupDiscount
    if (packingFee > 0) record.packingFee = packingFee
    if (minBuyNumber > 1) record.minBuyNumber = minBuyNumber

    records.push(record)
  })

  return { records }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const checkOnly = process.argv.indexOf('--check') >= 0
  const errors = []
  const warnings = []
  const err = (m) => errors.push(m)
  const warn = (m) => warnings.push(m)

  if (!fs.existsSync(SRC)) {
    console.error('找不到源文件：' + path.relative(process.cwd(), SRC))
    process.exit(1)
  }

  // ---- 分类映射 ----
  const cats = readJsonl(CATEGORIES, err)
  const catByName = {}
  const catById = {}
  cats.forEach((c) => {
    catByName[c.name] = c._id
    catById[c._id] = c.name
  })

  // ---- 读源文件 ----
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(SRC, 'utf8'))
  } catch (e) {
    console.error('goods-real.source.json 不是合法 JSON：' + e.message)
    process.exit(1)
  }
  const list = Array.isArray(raw) ? raw : (raw && raw.goods) || []
  if (!list.length) {
    console.error('源文件里没有商品（goods 数组为空）。')
    process.exit(1)
  }
  // 图片托管方式：源文件顶层 imageBase（不写 = 打进小程序包）
  const imageBase = Array.isArray(raw) ? '' : String((raw && raw.imageBase) || '').trim()
  if (imageBase && imageBase.charAt(0) !== '/' && !isCloudBase(imageBase) && !/^https?:/i.test(imageBase)) {
    err('imageBase 只支持以 / 开头的本地路径、cloud:// 云存储前缀或 https:// 外链，当前是：' + imageBase)
  }
  const cloudHosting = isCloudBase(imageBase)

  // ---- 逐条构建 ----
  const records = buildRecords(list, { catByName, catById, imageBase, err, warn }).records

  // ---- 图片体积（只在「图片打进小程序包」时才需要关心主包 2MB 限制）----
  if (!cloudHosting && fs.existsSync(IMG_DIR)) {
    let bytes = 0
    let n = 0
    fs.readdirSync(IMG_DIR).forEach((f) => {
      const st = fs.statSync(path.join(IMG_DIR, f))
      if (st.isFile()) {
        bytes += st.size
        n++
      }
    })
    if (n && bytes > 1.5 * 1024 * 1024) {
      warn(
        'images/goods/ 已有 ' +
          n +
          ' 个文件、共 ' +
          (bytes / 1024 / 1024).toFixed(2) +
          ' MB，接近小程序主包 2MB 上限；建议改用云存储（在源文件顶层加 imageBase）'
      )
    }
  }

  // ---- 报告 ----
  console.log('')
  console.log('商品录入校验 ' + path.relative(process.cwd(), SRC))
  console.log('─'.repeat(72))
  records.forEach((r) => {
    const cat = catById[r.categoryId] || '❓' + r.categoryId
    const sizeTxt = r.properties.length
      ? r.properties
          .map(
            (grp) =>
              grp.name +
              '(' +
              grp.childsCurGoods.map((o) => o.name + (o.priceDelta ? '+' + o.priceDelta : '')).join('/') +
              ')'
          )
          .join(' ')
      : '无规格'
    console.log(
      '  ' +
        r._id.padEnd(24) +
        ' ' +
        cat.padEnd(10) +
        ' ￥' +
        String(r.minPrice).padEnd(6) +
        ' ' +
        r.pics.length +
        '图  ' +
        sizeTxt
    )
  })
  console.log('─'.repeat(72))
  console.log('共 ' + records.length + ' 个商品')
  console.log(
    '图片托管：' +
      (cloudHosting
        ? '云存储 ' + imageBase + '（不受主包 2MB 限制，改图无需重新提审）'
        : imageBase
          ? '小程序包 ' + imageBase + '（占主包体积，改图要重新提审）'
          : '小程序包 /images/goods/（默认，占主包体积，改图要重新提审）')
  )

  warnings.forEach((w) => console.log('  ⚠ ' + w))
  if (errors.length) {
    console.log('')
    errors.forEach((e) => console.log('  ✗ ' + e))
    console.log('')
    console.log('校验不通过（' + errors.length + ' 个错误），未生成文件。')
    process.exit(1)
  }

  if (checkOnly) {
    console.log('  ✓ 校验通过（--check，未写文件）')
    return
  }

  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
  // 回读一次，确保生成物每行都能解析（导入失败最常见的坑）
  jsonl
    .split('\n')
    .filter(Boolean)
    .forEach((l, i) => {
      try {
        JSON.parse(l)
      } catch (e) {
        err('生成物第 ' + (i + 1) + ' 行无法解析：' + e.message)
      }
    })
  if (errors.length) {
    errors.forEach((e) => console.log('  ✗ ' + e))
    process.exit(1)
  }

  fs.writeFileSync(OUT, jsonl, 'utf8')
  console.log('  ✓ 已写入 ' + path.relative(process.cwd(), OUT) + '（' + records.length + ' 行，UTF-8）')

  // 同一个内容再存一份 .json：微信云开发控制台的「导入」文件选择框只认 .json / .csv，
  // .jsonl 可能不出现在列表里。内容完全一致（每行一个 JSON 对象 = JSON Lines），
  // 只是换个扩展名，免得你在导入那一步卡住。
  const OUT_JSON = OUT.replace(/\.jsonl$/, '.json')
  fs.writeFileSync(OUT_JSON, jsonl, 'utf8')
  console.log('  ✓ 已写入 ' + path.relative(process.cwd(), OUT_JSON) + '（同内容，给控制台导入用）')

  console.log('')
  console.log('下一步：微信开发者工具 → 云开发 → 数据库 → goods 集合 → 导入')
  console.log('        文件选 goods-real.json，冲突处理选「upsert」')
}

module.exports = {
  buildRecords,
  optionId,
  groupId,
  shortHash,
  GROUP_IDS,
  FLAVOR_IDS,
  LOCAL_IMAGE_BASE
}

if (require.main === module) main()
