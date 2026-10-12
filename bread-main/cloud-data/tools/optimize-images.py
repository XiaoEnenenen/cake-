#!/usr/bin/env python3
"""
商品图片压缩（放进小程序主包前必须做）
---------------------------------------------------------------------------
为什么必须压：小程序**主包上限 2 MB**，手机直出的照片单张就有 0.4–1.5 MB，
5 张就把主包撑爆（实测本店 5 张原图 = 2.22 MB，已超限）。
本脚本把图缩到小程序实际需要的分辨率并去掉 EXIF，单张通常降到 100–200 KB。

用法：
    python cloud-data/tools/optimize-images.py 源图1 输出名1 [源图2 输出名2 ...]
    python cloud-data/tools/optimize-images.py --max 1000 --quality 82 a.jpg b.jpg

    输出名只写文件名（不带路径），统一写到 bread-main/images/goods/。
    成对给参数；只给一个参数时，用源文件名（需已是英文/数字/中划线）。

示例：
    python cloud-data/tools/optimize-images.py "C:/tmp/IMG_001.jpg" danzai-party-cake-1.jpg

说明：
  --max     长边最大像素（默认 1000）。详情页轮播按 750@2x 显示，1000 足够。
  --quality JPEG 质量（默认 82）。
  --out     输出目录（默认 images/goods/，即打进小程序包的位置）。
            用云存储托管图片时应改成 cloud-data/goods-images/ —— cloud-data 已在
            project.config.json 的 packOptions.ignore 里，图片不会进小程序包。
  --dry-run 只报告压缩效果，不写文件。
---------------------------------------------------------------------------
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageOps
except ImportError:
    print("缺少 Pillow。请用工作区自带的 Python 运行本脚本。", file=sys.stderr)
    sys.exit(1)

HERE = os.path.dirname(os.path.abspath(__file__))          # cloud-data/tools
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))     # bread-main
DEFAULT_OUT = os.path.join(ROOT, "images", "goods")        # 打包进小程序的位置
PACKED_IMAGE_DIR = os.path.join(ROOT, "images", "goods")   # 参与主包体积计算的目录


def human(n):
    return f"{n / 1024:.0f} KB" if n < 1024 * 1024 else f"{n / 1024 / 1024:.2f} MB"


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("pairs", nargs="*", help="源图 输出名 成对给出")
    ap.add_argument("--max", type=int, default=1000)
    ap.add_argument("--quality", type=int, default=82)
    ap.add_argument("--out", default=None,
                    help="输出目录（默认 images/goods/；云存储托管时用 cloud-data/goods-images/）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.pairs:
        ap.print_help()
        sys.exit(1)

    out_dir = os.path.abspath(args.out) if args.out else DEFAULT_OUT

    # 解析成 (源, 输出名) 对
    items = []
    if len(args.pairs) % 2 == 0:
        for i in range(0, len(args.pairs), 2):
            items.append((args.pairs[i], args.pairs[i + 1]))
    elif len(args.pairs) == 1:
        src = args.pairs[0]
        items.append((src, os.path.basename(src)))
    else:
        print("参数必须是「源图 输出名」成对，或单个源图。", file=sys.stderr)
        sys.exit(1)

    if not args.dry_run:
        os.makedirs(out_dir, exist_ok=True)

    total_in = total_out = 0
    for src, outname in items:
        if not os.path.isfile(src):
            print(f"✗ 找不到源图：{src}", file=sys.stderr)
            sys.exit(1)
        if os.path.splitext(outname)[1].lower() not in (".jpg", ".jpeg", ".png"):
            outname += ".jpg"
        dst = os.path.join(out_dir, outname)

        im = Image.open(src)
        im = ImageOps.exif_transpose(im)  # 按 EXIF 摆正，避免手机上看着是躺倒的
        if im.mode not in ("RGB", "L"):
            im = im.convert("RGB")

        w, h = im.size
        scale = args.max / float(max(w, h))
        if scale < 1:
            im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)

        in_size = os.path.getsize(src)
        if args.dry_run:
            # 估算：写到临时文件量一下
            import io
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=args.quality, optimize=True, progressive=True)
            out_size = buf.tell()
        else:
            # 关键：不传 exif/icc_profile → EXIF（含拍摄地点等）不会被带进小程序包
            im.save(dst, "JPEG", quality=args.quality, optimize=True, progressive=True)
            out_size = os.path.getsize(dst)

        total_in += in_size
        total_out += out_size
        print(
            f"  {'(试算) ' if args.dry_run else ''}{os.path.basename(src)[:34]:<34} "
            f"{w}x{h} {human(in_size):>9}  →  {im.size[0]}x{im.size[1]} {human(out_size):>8}"
        )

    print(f"\n  合计 {human(total_in)} → {human(total_out)}"
          f"（省 {100 - total_out * 100 // max(total_in, 1)}%）")
    if not args.dry_run:
        print(f"  输出目录：{os.path.relpath(out_dir, ROOT)}")

    # 主包预算：只统计「打进小程序包」的那个目录（images/goods/），
    # 云存储模式的输出目录（cloud-data/）不参与主包体积，无需提醒
    packed = PACKED_IMAGE_DIR
    used = 0
    if os.path.isdir(packed):
        for f in os.listdir(packed):
            fp = os.path.join(packed, f)
            if os.path.isfile(fp):
                used += os.path.getsize(fp)
    if used:
        budget = 1.5 * 1024 * 1024
        pct = used * 100 / (2 * 1024 * 1024)
        print(f"  小程序包内 images/goods/ 占 {human(used)} ≈ 主包 2 MB 的 {pct:.0f}%"
              + ("   ⚠ 接近上限：改用云存储（源文件加 imageBase）" if used > budget else ""))
    if os.path.abspath(out_dir) != packed:
        print("  （输出目录不在小程序包内，不占主包体积）")


if __name__ == "__main__":
    main()
