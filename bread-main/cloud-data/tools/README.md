# cloud-data/tools — 真实商品录入工具

把**人写的商品源文件**转成**微信云开发控制台能直接导入的 `goods-real.json`**。

```
goods-real.source.json   ──[node build-goods.js]──►   ../goods-real.jsonl  +  ../goods-real.json
（分类写名字、尺寸写绝对价）                          （两份内容相同；导入时选 .json 那份）
```

> 🔴 **2026-10-14（阶段 10）起：店主能自己在小程序里改商品了，本工具不再是日常改价入口。**
>
> 口径是 **云库 = 唯一事实源**：店主在「店主中心 → 商品管理」里改过商品（改价/换图/上下架）后，
> **不要再跑 `build-goods.js` 重导** —— 控制台导入是 upsert，会把 `_id` 相同的记录整条盖回去，
> 她的修改就没了。这个脚本现在只用于：**① 首次初始化 ② 换云环境迁移 ③ 批量改价**
> （批量改价后请核对有没有覆盖她最近的修改）。
>
> 判断"她改过没有"：云开发控制台 → `goods` 集合 → 看记录里的 `updBy` / `updTime`
> （店主端每个写接口都会写这两个审计字段）。

> 💡 **导入时 `.json` 与 `.jsonl` 任选**（两份内容完全相同，脚本同时生成）。
> 控制台的导入选择框若按类型筛选、只列出 `.json`，就用 `goods-real.json` 那份；
> 只看得到一种时别以为文件丢了，先按 **F5 刷新**窗口，或在「文件名」里直接粘贴完整路径。
> 两份的一致性由 `tests/test-cleanup.js` 逐字节守着。

## 为什么不是直接手写 jsonl

`goods` 集合里有两个**不会报错、但会算错**的坑：

1. **`categoryId` 必须是 `category` 集合里真实存在的 `_id`**。
   写错 → 商品在任何分类下都不显示，页面上不报任何错，只是「没了」。
2. **`properties` 里生效的是 `priceDelta`（加价），不是绝对价**。
   本店算法是 `最终价 = minPrice + 各选中项加价之和`（[handlers.js](../../cloudfunctions/api/handlers.js) 的
   `calcPrice` / `getDelta`）。所以「6寸 128 / 8寸 188」要录成
   `minPrice=128`、`6寸 priceDelta=0`、`8寸 priceDelta=60`。
   把绝对价直接填进 `priceDelta`，客户看到的就会是 128+188=316。

脚本负责这三件事：分类名 → `_id`、绝对价 → 加价、图片文件名 → `/images/goods/<文件名>`，
外加查重 id / 缺价格 / 图片缺失 / 选项重名。

## 用法

```bash
cd bread-main

# 1. 压缩商品图（原图直出会撑爆 2MB 主包）
python cloud-data/tools/optimize-images.py 原图.jpg danzai-party-cake-1.jpg

# 2. 写源文件
cp cloud-data/tools/goods-real.source.example.json cloud-data/goods-real.source.json
# 改 goods-real.source.json ……
node cloud-data/tools/build-goods.js --check   # 只校验，看报告
node cloud-data/tools/build-goods.js           # 校验并生成 goods-real.jsonl

# 3. 验收：用云函数真实的计价/配送逻辑验算客户看到的价格
node cloud-data/tools/verify-goods.js
```

| 脚本 | 干什么 |
|---|---|
| `build-goods.js` | 源文件 → 校验 → 生成 `goods-real.jsonl`（分类名转 id、绝对价转加价、图片名转路径） |
| `verify-goods.js` | 核对生成物：分类 id 是否存在、真实 `calcPrice` 算出的最低价是否等于 `minPrice`、详情标签是否在 parser 白名单内、图片是否存在、蛋糕尺寸能否被配送规则识别 |
| `optimize-images.py` | 商品图缩放 + 去 EXIF，并报告主包占用（需工作区自带 Python + Pillow） |
| `sync-delivery.js` | **配送规则副本同步**：把 `config/delivery.js` / `utils/delivery-range.js` 生成云函数副本 `cloudfunctions/api/delivery-config.js` / `delivery-calc.js`（阶段 8 起） |
| `migrate-env.js` | **换云环境迁移**（阶段 6）：把所有文本文件里的旧环境 ID / appid 批量替换，**默认只预演**（`--apply` 才写文件）。控制台侧步骤见 [docs/换新号迁移清单.md](../docs/换新号迁移清单.md) |

---

## 配送规则的两份副本：不要手改云函数那份

微信云函数是**独立打包**的，不能 `require` 主包里的文件，所以配送规则与配送计算各有两份：

```
config/delivery.js       ──[node cloud-data/tools/sync-delivery.js]──►  cloudfunctions/api/delivery-config.js
utils/delivery-range.js  ──[node cloud-data/tools/sync-delivery.js]──►  cloudfunctions/api/delivery-calc.js
```

**只改主包那两份，然后跑一次脚本**：

```bash
cd bread-main
node cloud-data/tools/sync-delivery.js          # 生成/覆盖云函数副本
node cloud-data/tools/sync-delivery.js --check  # 只校验是否已同步（不写文件）
```

> ⚠️ 2026-10-12 的复核证明"手工改两份"一定会漂（副本头注释自指就是漂出来的）。
> 从阶段 8 起改为**脚本生成 + 测试逐字节守着**：
> `tests/test-delivery.js` 直接调用 `transform()` 与磁盘上的云函数副本比对，
> **只改一边、或改了主包忘了跑脚本，`npm test` 就会红。**

---

## 图片托管：两种模式，一行开关

图片放哪由**源文件顶层的一个字段**决定，商品条目一个字都不用改：

```json
{
  "imageBase": "cloud://<环境ID>.<bucket>/goods/",
  "goods": [ ... ]
}
```

| `imageBase` | 图片实际位置 | 上限 | 改一张图要做什么 |
|---|---|---|---|
| 不写（默认） | `bread-main/images/goods/`，**打进小程序包** | 受主包 **2 MB** 约束（本店 5 张已占 568 KB ≈ 28%） | 改图 → 重新上传小程序 → **重新提交审核** |
| `cloud://…/goods/` | 微信**云存储** | 免费额度 5 GB 容量（约 3 万张） | 只上传图片，**不用动代码、不用重新提审** |

`build-goods.js` 会自动识别：`imageBase` 是本地路径时检查文件存在、并统计主包体积；是 `cloud://` 时跳过这些检查。

### 从「打进包」迁到云存储（一次性）

1. **开发者工具 → 云开发 → 存储** → 新建文件夹，命名 `goods`
2. **顺手确认存储权限**：`存储 → 权限设置` 必须是「**所有用户可读**，仅创建者可读写」。
   商品图顾客要能看；若设成「仅创建者可读写」，你自己在开发者工具里能正常看到图，
   **顾客看到的却是裂图** —— 这种故障排查起来很费时间。
3. 进入 `goods` → **上传文件** → 选 `bread-main/images/goods/` 下所有 `.jpg`（**不要传 `README.md`**）
4. 上传完成后，点**任意一个文件** → 复制它的 **File ID**
5. 把 File ID 发回来（格式形如
   `cloud://cloud1-d7g2txuxpf22bb979.636c-cloud1-d7g2txuxpf22bb979-1300000000/goods/danzai-party-cake-1.jpg`）——
   从它就能推出 `imageBase`（去掉最后的文件名即可），不必逐个复制

> CloudPath 必须与源文件里 `images` 写**完全一致的文件名**，否则图片 404。
> 迁移完成后，`images/goods/` 里的 jpg 应当删掉（它们已不再被引用，留着白占主包体积），
> 之后 `optimize-images.py` 请加 `--out cloud-data/goods-images/` —— `cloud-data` 在
> `project.config.json` 的 `packOptions.ignore` 里，图片不会进包。


## 源文件字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 商品 `_id`，稳定不复用。不写会按名字生成 `g_real_<hash>`（插入别的商品不会变） |
| `name` | **是** | 商品名 |
| `category` | **是** | 分类名（如「水果蛋糕」），也接受 `cat_fruit_cake` 这种 `_id` |
| `images` | 否 | `images/goods/` 下的文件名，可多个；也接受 `cloud://` fileID 或 https 外链。第一张兼作列表缩略图 |
| `characteristic` | 否 | 列表页灰色小字，如「动物奶油 / 当季草莓」 |
| `content` | 否 | 详情文字，空行分段；会自动转成 `<p>` 富文本 |
| `sizes` | 二选一 | 磅数规格，写**绝对价**：`[{"name":"6寸","price":128}]`（决定 `minPrice`，其余自动转加价） |
| `price` | 二选一 | 无规格商品的单价（饼干、蜡烛等） |
| `flavors` | 否 | 口味，写**加价**：`[{"name":"巧克力","delta":10}]` |
| `specGroups` | 否 | **任意多组"加价型"规格**（阶段 9 起）：夹心一 / 夹心二 / 奶油类型 / 装饰…<br>写法：`[{"name":"夹心一","options":[{"name":"芒果"},{"name":"奥利奥","delta":5}]}]`<br>组内单选、每组必选；选项 `delta` 缺省 0。**绝对价规格（磅数）仍必须用 `sizes`**（否则 `minPrice` 算不出来，工具会报错） |
| `pickupDiscount` | 否 | **自取立减**（元/件，阶段 9）：自提时每件便宜这么多（美团上「外送 178 / 自取 168」就是这个）。不写 = 不区分渠道 |
| `packingFee` | 否 | **打包费**（元/件，阶段 9）：下单时按件计入总额并单列一行。不写 = 不收 |
| `minBuyNumber` | 否 | **最少购买份数**（阶段 9）：不加购够这么多份会被拦（加购/改数量/下单三处同口径）。不写 = 1 份 |
| `unit` / `purchaseNotes` / `sort` / `enabled` / `isCake` | 否 | 默认 `个` / 空 / `10` / `true` / 有磅数规格即为蛋糕 |

> 后三项（`pickupDiscount` / `packingFee` / `minBuyNumber`）都**只在"确实启用"时才写进记录**
> （0 / 1 视为未启用），所以加了这三个能力之后，存量商品数据逐字节不变。
> 金额的唯一口径在服务端：`cartSummary`（购物车/结算页显示）与 `orderCreate`（实付），
> 前端只显示服务端给的数，不自己乘件数。

### 规格组与选项 id 怎么来的（**由名字确定性生成，不要手改**）

组 id 与选项 id 会写进购物车 key 与订单快照，所以工具按名字稳定生成 —— **改名字等于换 id**：

| 组名 | 组 id | 选项名举例 | 选项 id |
|---|---|---|---|
| 磅数 / 尺寸 | `size` | 6寸 / 8寸 | `s6` / `s8` |
| 口味 | `flavor` | 芒果 / 巧克力 | `f_mango` / `f_chocolate` |
| 夹心一 / 夹心二 | `filling1` / `filling2` | 奥利奥 | `f_oreo` |
| 奶油类型 | `cream` | 动物奶油 | `f_freshcream` |
| 生日插件 / 装饰 | `decoration` | 皇冠 | `f_<短哈希>` |
| 其它任意组名 | `spec_<短哈希>` | —— | `f_<短哈希>` |

> 词典没命中的名字会落到短哈希（同样稳定）；想让 id 更可读，在 `build-goods.js` 的
> `FLAVOR_IDS` / `GROUP_IDS` 里各加一行即可。
> `tests/test-build-goods.js` 守着这些映射，另外还守着一条更重要的：
> **磁盘上的 `goods-real.jsonl` 必须等于"用当前源文件重新生成"的结果** ——
> 改了源文件忘记跑脚本，`npm test` 就会红（导入过期价格是这类工具最典型的坑）。

## 导入到云库

云开发控制台 → 数据库 → `goods` 集合 → 「导入」→ 选 `cloud-data/goods-real.json`（或 `.jsonl`，同内容）
→ 冲突处理选 **upsert**。

> `upsert` 的意义：用同一份 `_id` 反复导入就是**更新**。改了价格重跑脚本再导一次即可，
> 不会产生重复商品，也不需要先删记录。（`goods-sample.jsonl` 那 5 个测试商品建议在录真实商品前删掉，
> 否则会和真实商品混在列表里。）

## 别忘了

- **图片得先放好**：`build-goods.js` 只能提醒「图片不存在」，不会替你生成图；
  压缩用 `optimize-images.py`，存放位置与 `imageBase` 的对应关系见上方「图片托管」一节。
- 主包 2 MB 限制（**只在图片打进包时才有**）：图片总量超 1.5 MB 脚本会提醒。
  本店实测 **5 张手机原图 = 2.22 MB（已超限）**，压缩后 568 KB —— 所以压缩这步不能省。

## 录入一个新商品的完整动作

```bash
# ① 存图 + 压缩
#    打进小程序包（开发期）：
python cloud-data/tools/optimize-images.py "手机导出的图.jpg" my-cake-1.jpg
#    云存储托管（推荐，长期）：
python cloud-data/tools/optimize-images.py --out cloud-data/goods-images "手机导出的图.jpg" my-cake-1.jpg
#    → 再把 cloud-data/goods-images/my-cake-1.jpg 上传到云存储 goods/ 文件夹

# ② 在 goods-real.source.json 的 goods 数组里加一条（字段见上表）

# ③ 生成 + 验收
node cloud-data/tools/build-goods.js && node cloud-data/tools/verify-goods.js

# ④ 云开发控制台 → 数据库 → goods → 导入 goods-real.jsonl → 冲突处理选 upsert
```

改动只集中在 `goods-real.source.json` 一处；`goods-real.jsonl` 是生成物，不要手改。

