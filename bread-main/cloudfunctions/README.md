# cloudfunctions — 云函数部署说明

这个目录是**自建后端**，替代原来绑死在 api工厂 SaaS 上的数据层。

---

## 为什么只有一个云函数？

原项目前端是通过 `apifm-wxapi` 这个 SDK「一个入口调几十个接口」的模式工作的。
如果拆成十几个云函数，前端每个调用都要改名、改参数，改动量会大很多。

所以这里用**一个云函数 + action 路由**：

```
wx.cloud.callFunction({
  name: 'api',
  data: { action: 'goodsList', payload: { categoryId: 'xxx' } }
})
```

路由表在 `api/handlers.js` 末尾的 `handlers` 对象里。

---

## 目录结构

```
cloudfunctions/
  api/
    index.js        云函数入口（依赖 wx-server-sdk，只能在云端跑）
    handlers.js     全部业务逻辑（不依赖 wx-server-sdk，可本地测试）
    package.json    声明 wx-server-sdk 依赖
```

**这个拆分是刻意的**：业务逻辑都在 `handlers.js`，它只依赖一个注入的 `db` 对象，
因此可以在没有 AppID、没有云环境的情况下用假数据本地跑测试。

---

## 已实现的接口

> **路由表实际可调用的 action 共 33 个**（`handlers.js` 的 `handlers` 导出对象，
> 由 `tests/test-cleanup.js` 断言数量与本文档一致）。下表多出的 `importData`
> 已不在路由表里，仅通过 `module.exports` 暴露给云控制台/本地测试。

| action | 对应原来的 | 说明 |
|---|---|---|
| `getUser` | `userDetail` | 当前用户资料（身份取 OPENID） |
| `updateUser` | `modifyUserInfoV2` | 更新昵称/头像/性别/生日/手机号 |
| `bindMobile` | `bindMobileWxappV2` | 手机号绑定（**当前返回"未接入"**，需小程序后台开通手机号快速验证） |
| `appConfig` | `queryConfigBatch` | 店铺配置：`mallName` / `order_remark_msg` / `order_hx_uids`（2026-09-26 阶段一新增） |
| `cmsPage` | `cmsPage` | 用户隐私协议 / 常见问题正文，内容取自 `api/shop-config.js` 的 `cms`（阶段一新增） |
| `importData` | — | 初始化用：把种子数据（分类/商品/轮播/店铺配置）一次性写入集合。与 `cloud-data/*.jsonl` 内容一致。**⚠️ 2026-10-09 阶段二起已从公开路由移除**：只能在云开发控制台「云函数 → 云端测试」或本地测试脚本里调用，`callFunction` 拿不到（见下方路由表处注释） |
| `banners` | `banners` | 首页轮播图 |
| `categoryList` | `goodsCategoryV2` | 分类列表，只返回 enabled 的 |
| `goodsList` | `goodsv2` | 商品列表，按 categoryId 过滤 |
| `goodsDetail` | `goodsDetailV2` | 商品详情（含规格组） |
| `cartInfo` | `shippingCarInfo` | 购物车 |
| `cartAdd` | `shippingCarInfoAddItemV2` | 加购（同规格累加，校验必选规格） |
| `cartModifyNumber` | `shippingCarInfoModifyNumber` | 改数量（0 则删除） |
| `cartRemoveItem` | `shippingCarInfoRemoveItem` | 删除一项 |
| `cartRemoveAll` | `shippingCarInfoRemoveAll` | 清空 |
| `orderCreate` | `orderCreate` | 下单（服务端重算金额、清购物车；**不涉及库存**） |
| `orderList` | `orderList` | 订单列表 |
| `orderDetail` | `orderDetail` | 订单详情（含 `_openid` 二次校验） |
| `orderClose` | `orderClose` | 取消订单 |
| `orderDelete` | `orderDelete` | 删除订单 |
| `orderFinish` | `orderFinish` | 完成订单（店主手动，取代原 `orderHx` 扫码核销） |
| `orderAdminList` | `orderAdminList` | **店主视角订单列表**（2026-10-14 新增，T-3）：跨顾客查询 + `requireAdmin` 鉴权，带收货人/电话/地址/期望时间；**不返回 `_openid`** |
| `goodsAdminList` | — | **店主视角商品列表**（2026-10-14 阶段 10）：含**已下架**商品（顾客端 `goodsList` 只返回上架的，下架后就找不回来了）+ 分类下拉 + 关键词搜索；`requireAdmin` |
| `goodsUpsert` | — | **新增/编辑商品**（阶段 10）：名称/分类/价格/图片/规格组/上下架/排序/自取立减/打包费/最少购买；**没传的字段沿用旧值**（可只传 `{id, enabled}` 切上下架）；`requireAdmin` + 入参白名单校验 + `updBy/updTime` 审计 |
| `goodsDelete` | — | **下架商品**（阶段 10，软删）：只把 `enabled` 置 false，**不物理删除**（可随时重新上架，历史订单是快照不受影响）；`requireAdmin` |
| `deliveryRuleSave` | — | **保存配送设置**（阶段 10，写 `app_config.delivery_rule`）：距离阶梯 / 不送区域 / 外送距离上限 / 配送范围关键词 / 蛋糕免运费；**先显式校验再归一化**（非法值报错拒绝，不静默回退默认值）；`requireAdmin` |
| `orderFreightConfirm` | — | **运费补录**（阶段 10）：「运费待确认」的外送单，店主电话谈好后写入 `freight` 并由服务端重算 `amountReal = goodsAmount - couponAmount + packingFee + freight`；只对下单时运费待确认（或已补录过）的未完成订单开放；`requireAdmin` + 审计 |
| `couponList` | — | **顾客端可见的券**（阶段 11，只读）：已启用 + 有效期内 + 没被用完的券，附该顾客自己的资格（新客 / 每人限用是否已用完）与券面说明；不涉及金额计算 |
| `couponUsableForCart` | — | **结算页可用券 + 预估优惠**（阶段 11，只读）：按当前购物车与配送方式，服务端算出每张券能否用、能减多少，并给出默认最优券；**金额的唯一预览出处** |
| `couponAdminList` | — | **店主端券列表**（阶段 11）：含已停用券，带使用量 / 命中上限 / 当前状态 / 有效期文案；`requireAdmin` |
| `couponUpsert` | — | **新建 / 编辑 / 停用券**（阶段 11）：新客立减或满减，有效期、总量、每人限用、排序、启用；**没传的字段沿用旧值**（可只传 `{id, enabled}` 停用）；`usedCount` 只由服务端维护；`requireAdmin` + 入参校验 + 审计 |
| `wxpay` | `wxpay` | 微信支付统一下单（**当前返回"未接入"**，需先申请商户号，阶段一未接线） |
| `fetchShops` | `fetchShops` | 单店模式兼容桩，固定返回空数组（前端已无调用方） |
| `shopSubdetail` | `shopSubdetail` | 单店模式兼容桩，固定返回失败（`pages/current-order` 拨号取号用） |

> **2026-02-14 更正（按 handlers.js 路由表实际核对）**：以下 2 个 action 已随业务模块删除，
> 本文档此前仍在列出，现移除：
> - `scoreLogs` —— 会员积分体系已删除（会员/积分/积分记录整体不做）
> - `orderPay` —— 余额支付已删除（`cloudfunctions/api/handlers.js` 内有就地注释）

集合清单：

| 集合名 | 用途 |
|---|---|
| `category` | 商品分类 |
| `goods` | 商品（字段结构见 `cloud-data/02-schema-goods.js`） |
| `banner` | 首页轮播图（字段：`picUrl` / `link` / `sort` / `enabled`） |
| `app_config` | **可选**。店铺配置覆盖（字段：`key` / `value`）。不存在时 `appConfig` action 会使用 `api/shop-config.js` 的默认值，不报错（2026-09-26 阶段一新增） |
| `user` | 用户资料（按 `_openid` 隔离） |
| `cart` | 购物车（按 `_openid` 隔离） |
| `order` | 订单（按 `_openid` 隔离） |
| `coupon` | 优惠券活动（阶段 11；店主建、顾客用。`usedCount` 由服务端原子累加，用于总量上限） |
| `coupon_user` | 每人用券计数（阶段 11；按 `_openid` + `couponId` 隔离，用于每人限用与并发防超发） |

> **2026-02-14 更正**：`score_log`（积分记录）集合**不用建** —— 会员积分体系已整体删除。

---

## 前端如何接线

页面**不再直接依赖 apifm-wxapi**，统一走 `utils/api-map.js`：

```js
const API = require('../../utils/api-map')   // 原来：const WXAPI = require('apifm-wxapi')

const res = await API.goodsv2({ categoryId: cid })   // 原来：WXAPI.goodsv2(...)
```

`api-map` 是**唯一的数据出口**：所有调用都打到云函数 `api`（`utils/data-source.js` 里
只有 `useCloud` 一个开关，且没有第二个数据源可切）。

**登录的差异**：
- 身份由 `cloud.getWXContext().OPENID` 自动提供，**没有 token**，
  `utils/auth.js` 里 `isCloudMode()` 直接读 `utils/data-source.js` 的 `useCloud`（单一判据）
- 原 api工厂 的 `code` 换 `token` 流程已在阶段三整体删除

> **2026-10-09 阶段三更正**：此前这里写「`useCloud: false` → 透传给原 api工厂 SDK（备用通道）」。
> 该通道已删除（审计 A-P0-01 / A-P1-01 / A-P1-02）：`utils/services/legacy-apifm.js` 与
> `bread-main/config.js`（原面包店账号）已归档到 `.trash-cleanup\20261009-1815\`，
> `apifm-wxapi` 依赖也已从 `package.json` 移除。云函数不可用时页面直接提示
> 「云函数调用失败：…」，不会静默换源。

> **2026-02-14 更正**：本文档此前写「已接线的文件（14 个）：11 个页面 + `utils/auth.js` + `utils/tools.js` + `app.js`」。
> 经核对，`utils/tools.js` **已不存在**（全项目无该文件）。
>
> **2026-10-12 阶段 5.7 再次核对**（`tests/test-cleanup.js` 会重新数一遍并断言本文档的数字）：
> **2026-10-17 阶段 12 更新**：新增「编辑资料」页后，实际接线为 **16 个页面** +
> `utils/auth.js` + `utils/pay.js` + `utils/admin.js` + `utils/privacy.js` +
> `components/bind-mobile` + `components/privacy-popup` + `app.js`。
> 16 个页面是：`about-us/detail`、`current-order`、`goods-details`、`index`、`my`、
> `order-view`、`orders`、`pay`，阶段 10 的 5 个店主端页面
> `admin/index`、`admin/orders/index`、`admin/goods/index`、`admin/goods-edit/index`、
> `admin/delivery/index`，阶段 11 的 2 个优惠券页面
> `admin/coupons/index`（券列表）、`admin/coupons-edit/index`（新建/编辑），
> 以及阶段 12 的 `profile-edit/index`（编辑资料）
> （店主端 7 个页面都不进 tabBar，普通顾客看不到入口）。
> （此前这里写的「13 个页面」是 api 工厂时代的数字，从未复核过；报告 E-07 已记录该文档与代码不符。）
>
> `utils/pay.js` 的支付统一下单仍未接线（见文末），云开发通道会返回"未接入"文案。


---

## 部署步骤

> 前提：已注册小程序并拿到 AppID，且在开发者工具里开通了云开发环境。

> 2026-09-26 阶段一：`project.config.json` 已补上 `"cloudfunctionRoot": "cloudfunctions/"`，
> 开发者工具现在应能把 `cloudfunctions/api` 识别为云函数目录（此前缺失，无法右键上传）。

1. 微信开发者工具打开本项目
2. 点顶部「**云开发**」→ 开通环境（记下环境 ID）
3. 左侧「**云函数**」→ 右键 `cloudfunctions/api` 目录 → 「**上传并部署：云端安装依赖**」
4. 等待部署完成，控制台应显示上传成功
5. 在「云开发 → 数据库」建立 9 个集合：

| 集合名 | 用途 | 权限建议 |
|---|---|---|
| `category` | 商品分类 | 所有用户可读，仅创建者可写 |
| `goods` | 商品 | 所有用户可读，仅创建者可写 |
| `banner` | 首页轮播图 | 所有用户可读，仅创建者可写 |
| `app_config` | 店铺配置（可选） | 所有用户可读，仅创建者可写 |
| `user` | 用户资料 | **仅创建者可读写** |
| `cart` | 购物车 | **仅创建者可读写** |
| `order` | 订单 | **仅创建者可读写** |
| `coupon` | 优惠券（阶段 11） | **仅创建者可读写**（顾客只经云函数读写，不直接碰集合） |
| `coupon_user` | 每人用券计数（阶段 11） | **仅创建者可读写** |

> **2026-02-14 更正**：`score_log`（积分记录）集合**不用建** —— 会员积分体系已整体删除。
> 完整的建库清单与权限说明以 `docs/云开发初始化清单.md` 为准。

> 权限很重要：`cart` 和 `order` 必须是「仅创建者可读写」，
> 云开发会自动按 `_openid` 隔离，顾客之间看不到彼此的购物车和订单。
> 代码里也做了二次校验（见 `orderDetail` 的 `_openid` 比对）。

6. 导入分类：用 `cloud-data/categories.jsonl`（见该目录的 README）
7. 手动录入商品（结构见 `cloud-data/02-schema-goods.js`）
8. 确认 `utils/data-source.js` 的 `cloudEnvId` 与本步骤 2 记下的环境 ID 一致
   （阶段三起数据源只有云开发一条，**没有开关需要打开**；`useCloud` 保持 `true` 即可）
9. 在微信开发者工具「云开发 → 设置」里，确认云函数已能调用
10. **（2026-10-12 新增）确认「定时触发器」真的建出来了**：
    `cloudfunctions/api/config.json` 里声明了触发器 `orderTimeoutCancel`
    （每 5 分钟跑一次，把 **15 分钟**未支付的订单自动置为「已取消」）。
    ⚠️ 上传云函数**不一定会**把触发器一起建出来，请到
    「云开发 → 云函数 → api → 定时触发器」确认它已出现；没有就手动新建 / 重新上传触发器。
    超时分钟数在 `cloudfunctions/api/shop-config.js` 的 `orderTimeoutMinutes`（改完要重新部署）。
    > **兜底（2026-10-12）**：即使触发器没建、或比预期晚跑，顾客一打开订单列表/详情，
    > 云函数也会先把该顾客已超时的待支付订单取消掉（`handlers.js` 的 `expireUnpaidForViewer`），
    > 所以不会再出现"待支付订单永远挂在列表里"。

---

## 数据源只有一条（2026-10-09 阶段三）

云函数是**唯一**数据源，没有「切回原后端」这回事：

- 云函数没部署 / 环境 ID 不对 / 网络不通 → 页面提示「**云函数调用失败：<原始 errMsg>**」，
  按提示修云环境即可，**不会**把请求发给别处；
- 云函数通了但业务出错 → 页面显示云函数返回的业务文案（如「数据库错误」），
  按内容排查云库数据，与上一条是两回事；
- 需要回滚这次改造 → 优先用 `git revert aa70a73`（阶段三提交，含全部改动）。
  本机另留有归档副本 `.trash-cleanup\20261009-1815\`（**该目录不入版本控制**，新 clone 没有）；
  被删的两个文件也可从历史取回：
  `git checkout 307a5a1 -- bread-main/config.js bread-main/utils/services/legacy-apifm.js`。

---

## 本地测试

业务逻辑不需要云环境就能验证。在项目根目录执行：

```
npm test
```

或单独执行：

```
node tests/test-cloud-api.js
node tests/test-spec.js
node tests/test-address.js
node tests/test-delivery.js
node tests/test-admin.js     # 阶段 10 店主端
node tests/test-coupon.js    # 阶段 11 优惠券（含并发防超发 / 结算页 / 店主建券）
node tests/test-profile.js   # 阶段 12 隐私合规 / 退出登录 / 编辑资料
```

`tests/test-cloud-api.js` 用内存版数据库跑完整流程：分类 → 商品 → 加购 → 下单 → 查单 → 取消 → 核销，
覆盖价格计算、多用户隔离、防改价、错误处理等断言。

> **2026-02-14 更正**：本文档此前写「`node _test-api.js`」——该文件**不存在**，正确路径是 `tests/test-cloud-api.js`；
> 此前写的「52 项断言」也已过期。四个脚本的脚本名与断言数请以 `package.json` 的 `scripts` 与实跑结果为准
> （实测：`test-cloud-api.js` 74 项、`test-spec.js` 27 项、`test-address.js` 33 项、`test-delivery.js` 103 项，全部通过）。

---

## 安全设计要点

1. **服务端重算金额**：下单时不信任前端传来的 `price`/`amount`，
   一律用数据库里的商品价格 + 规格加价重新计算（已验证：前端传 `price: 0.01` 会被忽略）。
2. **数量与规格校验在服务端**：下单校验数量是合理正整数（单行上限 99，重复行合并后仍受该上限约束）、
   规格每组必选且选项合法；**本店没有库存概念**，不校验也不扣减库存（2026-10-09 删除）。
3. **用户隔离**：购物车与订单的读写都按 `_openid` 过滤。
4. **规格必选校验**：商品有规格组时，每组都必须选，且选项必须属于该商品。

---

## 第 2 阶段（拿到商户号后）

支付相关代码位置已预留：

- `api/index.js` 里的 `handlePayCallback()`：微信支付结果回调入口

> **2026-02-14 更正**：此处此前还列了「`orderPay` action：标记订单已支付」。
> 该 action 已随会员余额体系一并删除（`handlers.js` 内有就地注释），现移除。

接入方式建议用 `cloud.cloudPay.unifiedOrder()`（云开发支付），
可以省掉自己写签名和处理证书的部分。`utils/pay.js` 里
`wx.requestPayment` 那段结构可以直接复用。
