# images/goods — 商品图片（**打进小程序包**的位置）

商品图放这里，文件名用英文/数字/中划线，**不要有空格**（小程序打包对特殊字符不友好）。

在 `cloud-data/goods-real.source.json` 里只写文件名即可，脚本会自动补成 `/images/goods/<文件名>`：

```json
"images": ["strawberry-cake-1.jpg", "strawberry-cake-2.jpg"]
```

第一张图会同时作为列表页缩略图（`pic`），全部会进详情页轮播（`pics`）。

## ⚠️ 这个目录里的文件会算进小程序主包体积

主包上限 **2 MB**，代码+字体+图片全都算。手机直出的照片单张 0.4–1.5 MB，
**必须先用 `cloud-data/tools/optimize-images.py` 压缩**再放进来（该脚本会同时去掉 EXIF）。

实测：本店 5 张原图 2.22 MB（已超限）→ 压到 568 KB。

## 图片多了要换云存储

大约再放 10 张就到 2 MB 上限。换云存储的完整步骤见
[cloud-data/tools/README.md 的「图片托管」一节](../../cloud-data/tools/README.md#图片托管两种模式一行开关)。

要点：切换只是在 `goods-real.source.json` 顶层加一行 `imageBase`，
换完之后**这个目录里的 jpg 应当删掉**（不再被引用，留着白占主包体积），
之后压缩输出请改用 `--out cloud-data/goods-images/`（`cloud-data` 不参与打包）。

## 图片尺寸建议

列表图 1:1、详情图 4:3 或 1:1，宽度 1000px 左右足够（详情页轮播按 750@2x 显示），不必放原图。
