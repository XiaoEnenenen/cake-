# cloud-data/tools — 真实商品录入工具

把**人写的商品源文件**转成**微信云开发控制台能直接导入的 `goods-real.jsonl`**。

```
goods-real.source.json   ──[node build-goods.js]──►   ../goods-real.jsonl
（分类写名字、尺寸写绝对价）                          （每行一条 JSON，控制台「导入」用）
```

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
| `sizes` | 二选一 | 磅数规格，写**绝对价**：`[{"name":"6寸","price":128}]` |
| `price` | 二选一 | 无规格商品的单价（饼干、蜡烛等） |
| `flavors` | 否 | 口味，写**加价**：`[{"name":"巧克力","delta":10}]` |
| `unit` / `purchaseNotes` / `sort` / `enabled` / `isCake` | 否 | 默认 `个` / 空 / `10` / `true` / 有磅数规格即为蛋糕 |

## 导入到云库

云开发控制台 → 数据库 → `goods` 集合 → 「导入」→ 选 `cloud-data/goods-real.jsonl`
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

