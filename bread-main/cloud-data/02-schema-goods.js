// ===========================================================================
// 商品集合（goods）字段结构
// ---------------------------------------------------------------------------
// 2026-10-09：**本店没有库存概念**，goods 不再有 stores 字段，
//          商品详情/列表也不再返回库存、不再显示「已售罄」。
// ---------------------------------------------------------------------------
// 设计依据：按小程序页面「实际读取的字段」反推，不凭空造字段。
// 来源文件：
//   pages/orders/index.wxml      商品列表（左图右文）
//   pages/goods-details/index.js 商品详情 + 规格选择
//   pages/pay/index.js           结算页（读取 purchaseNotes）
//   pages/order-view/index.wxml  订单详情（读的是订单快照，不是本集合）
// ---------------------------------------------------------------------------
// 字段速查：
//
//   【商品列表页】pages/orders/index.wxml
//     item.name           商品名                        必填
//     item.pic            列表缩略图                    必填
//     item.characteristic 简介（灰色一行）              选填
//     item.minPrice       显示价格                      必填
//     item.id             商品唯一标识，加购与详情跳转都用 必填
//
//   【商品详情页】pages/goods-details
//     goodsDetail.basicInfo.id             商品 id
//     goodsDetail.basicInfo.name           商品名
//     goodsDetail.basicInfo.minPrice       价格
//     goodsDetail.basicInfo.unit           单位（如「个」「磅」）
//     goodsDetail.basicInfo.purchaseNotes  购买须知，结算页顶部滚动条显示
//     goodsDetail.pics                     轮播图数组（至少 1 张）
//     goodsDetail.content                  详情富文本 HTML（parser 组件渲染）
//     goodsDetail.properties               规格组（见下方）
//
//   【分类归属】
//     categoryId          指向 category 集合的 _id，列表按它过滤
// ---------------------------------------------------------------------------
// ⚠️ 规格结构（重要）
//   本店蛋糕需要「磅数 + 口味」这类【多组】规格，因此数据结构按「多组」设计。
//   ✅ 前端已完整支持多组规格（2026-02-14 核实）：
//      - js：buildPropertyGroups / buildSku / isSameSku
//      - wxml：按 specGroups 循环渲染，每组一组「单选」标签
//      - 修复了 checkBuyedNumber 只比对 sku[0] 导致的「串位」bug
//      - 验证：tests/test-spec.js 27 项断言通过
//   价格规则（用户确认）：选项是「加价」，最终价 = 商品 minPrice + 各选中项 priceDelta 之和
//   例：minPrice 54，选 6寸(priceDelta 34) + 巧克力(priceDelta 10) → 98
//   （服务端同一规则见 cloudfunctions/api/handlers.js 的 calcPrice）
//
// ⚠️ 2026-10-12 阶段 5.7 修正（审计报告 E-07）：
//   下面 example_goods 的规格选项原来写的是 `price`（那是 api 工厂时代的字段名），
//   而全项目**实际生效、且前后端都只认**的字段是 `priceDelta`。
//   照旧示例录入会导致每个选项的加价都按 0 处理 → 所有尺寸同价。
//   已改为 priceDelta，数值与 handlers.js 的一键导入种子数据保持一致。
// ===========================================================================

module.exports = {
  collection: 'goods',

  fields: {
    _id: '云数据库自动生成',
    id: '商品唯一标识（可用 _id 或自定义数字 id；前端用作加购与跳转参数）',
    categoryId: '所属分类的 _id',
    name: '商品名，如「慕斯围边水果小蛋糕 [4寸]」',
    pic: '列表缩略图 URL 或云存储 fileID',
    pics: '轮播图数组，详情页使用',
    characteristic: '简介，列表页灰色小字，如「动物奶油 / 约400克」',
    content: '详情富文本 HTML',
    minPrice: '最低价（有规格时取规格里的最低价）',
    unit: '单位，如「个」',
    purchaseNotes: '购买须知，显示在结算页顶部',
    sort: '排序，越小越靠前',
    enabled: '是否上架',
    properties: '规格组数组，见下方 example_goods'
  },

  example_goods: {
    id: 10001,
    categoryId: '替换为 category 集合里对应分类的 _id',
    name: '慕斯围边水果小蛋糕 [4寸]',
    pic: 'cloud://你的环境ID.goods/musi-4cun.jpg',
    pics: [
      'cloud://你的环境ID.goods/musi-4cun-1.jpg',
      'cloud://你的环境ID.goods/musi-4cun-2.jpg'
    ],
    characteristic: '水果味 / 蛋糕胚 / 约400克',
    content: '<p>动物奶油制作，当日现做。</p>',
    minPrice: 54,
    unit: '个',
    purchaseNotes: '蛋糕需冷藏保存，建议2小时内食用。',
    sort: 10,
    enabled: true,
    properties: [
      {
        id: 'size',
        name: '磅数',
        // ⚠️ 2026-10-12 阶段 5.7 修正：这里原来写的是 `price`，而**实际生效的字段是 `priceDelta`**。
        //    照旧示例录入 → 每个选项的加价都被当成 0 → 所有尺寸同价（54 元），
        //    属于"照文档做就错"（审计报告 E-07）。
        childsCurGoods: [
          { id: 'size_4', name: '4寸', priceDelta: 0 },
          { id: 'size_6', name: '6寸', priceDelta: 34 },
          { id: 'size_8', name: '8寸', priceDelta: 74 }
        ]
      },
      {
        id: 'flavor',
        name: '口味',
        childsCurGoods: [
          { id: 'flavor_strawberry', name: '草莓', priceDelta: 0 },
          { id: 'flavor_mango', name: '芒果', priceDelta: 0 },
          { id: 'flavor_chocolate', name: '巧克力', priceDelta: 10 }
        ]
      }
    ]
  },

  properties_explained: {
    说明: 'properties 是数组，每一项是一个规格组；每个规格组的 childsCurGoods 是可选项。',
    'id': '规格组 id，前端拼 sku 时作为 optionId',
    name: '规格组显示名，如「磅数」「口味」「夹心一」「奶油类型」',
    'childsCurGoods[].id': '选项 id，前端作为 optionValueId',
    'childsCurGoods[].name': '选项显示名',
    'childsCurGoods[].priceDelta': '该选项的【加价】（0 表示不加价）。★ 实际生效字段，选它就对了',
    注意1: '原项目里 optionId 与 optionValueId 参与字符串拼接，云开发改造时建议统一为字符串 id',
    注意2: '多规格已不再是硬伤（2026-02-14 更正）：前端支持多组规格，每组单选，' +
           '价格 = minPrice + 各选中项 priceDelta 之和。服务端同一规则见 handlers.js 的 calcPrice。',
    注意3: '组数没有上限：阶段 9（2026-10-14）起 tools/build-goods.js 支持 specGroups，' +
           '可一次生成"磅数 + 口味 + 夹心一 + 夹心二 + 奶油类型"任意组；' +
           '组 id 由组名稳定生成（夹心一 → filling1、奶油类型 → cream、口味 → flavor、磅数 → size），' +
           '组内选项 id 由选项名稳定生成（芒果 → f_mango、6寸 → s6）。',
    注意4: '基础价（minPrice）只能由 sizes（绝对价）或 price 决定；' +
           '夹心/奶油这类"加价型"选项写在 specGroups 里，写 delta 而不是 price。'
  },

  cart_structure: {
    说明: '购物车集合（cart）结构，供云开发改造时参考。当前购物车存在 api工厂 服务器。',
    fields: {
      _openid: '用户 openid，云开发自动注入，用于区分用户',
      goodsId: '商品 id',
      number: '数量',
      sku: '已选规格数组，如 [{ optionId, optionValueId }]',
      dateAdd: '加入时间'
    }
  }
}
