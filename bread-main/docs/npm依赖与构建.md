# npm 依赖与「构建 npm」说明

> 建立日期：2026-10-09（事故复盘后补写）
> 适用：`bread-main/` 目录下的所有小程序构建

---

## 一、当前依赖（`package.json`）

| 包 | 版本 | 说明 |
|---|---|---|
| `@vant/weapp` | **`1.11.7`（精确锁定，无 `^`）** | UI 组件库。**不要改成 `^` 范围**，见下方事故记录 |

> 2026-10-10：`wxbarcode` 已移除。原因是扫码核销整体下线（订单详情不再绘制核销二维码），
> 代码里已无任何引用，`package.json` / `package-lock.json` / `miniprogram_npm/wxbarcode` 一并清理。

`apifm-wxapi` 已于 **阶段三**（2026-10-09）整体移除，不再有第二个数据源，见
`cloudfunctions/README.md` 的「数据源只有一条」。

---

## 二、事故记录：一次「构建 npm」把组件库降级了

**现象（2026-10-09 18:20）**：在开发者工具里点「工具 → 构建 npm」后，模拟器报

```
module 'miniprogram_npm/@vant/weapp/mixins/open-type.js' is not defined,
require args is '../mixins/open-type'
```

真机预览同时显示「编译 .wxss 文件错误」，页面空白。

**根因**：

1. 本仓库的 `node_modules/` 是**从别的机器拷来的**（`node_modules/@vant/weapp/package.json` 里
   `_where` 仍写着 `F:\小程序\蛋糕店`），版本是 **1.2.2**（2019 年）；
2. 而随项目一起拷来的 `miniprogram_npm/@vant/weapp` 是**更早用 1.11.x 构建的产物**
   （72 个目录 / 466 文件 / 447.3 KB，含 1.2.2 根本没有的 `cascader`、`share-sheet`）——
   小程序运行时一直用的是它，所以此前一切正常；
3. 「构建 npm」会用 `node_modules` **重新生成** `miniprogram_npm`，于是组件库被
   从 1.11.x **静默降级**成 1.2.2（68 目录 / 313 文件 / 366.4 KB），与页面已编译的模块表不一致，
   启动即报「module not defined」。

这正是第一阶段审计报告 **D-09 / A-P1-04** 预警的"依赖三处版本冲突，重建 npm 即崩"。

**已做的修复**：

- `npm install @vant/weapp@1.11.7 --save-exact`，把 `node_modules` 恢复成运行时一直在用的版本；
- `package.json` 由 `^1.11.7` 改为精确 `1.11.7`，`package-lock.json` 重新生成（lockfileVersion 3）；
- 按「构建 npm」的等价结果重建了 `miniprogram_npm/@vant/weapp`（已逐字节校验一致）。

---

## 三、「构建 npm」到底做了什么（实测结论）

对 `@vant/weapp` 这类在 `package.json` 里声明了 `"miniprogram": "lib"` 的包，
开发者工具的「构建 npm」**就是把 `node_modules/@vant/weapp/lib/` 原样复制到
`miniprogram_npm/@vant/weapp/`**——实测 466 个文件**逐字节相同**（SHA256 全等），
不做转译、不裁剪。

因此产物是**可预测**的，也意味着：`node_modules` 里是什么版本，产物就是什么版本。

---

## 四、正确操作顺序（每次动依赖后照做）

```powershell
cd bread-main
npm install                 # 或 npm ci（lock 已是 v3，会精确装 1.11.7）
# 然后在开发者工具里：工具 → 构建 npm
# 最后：编译（Ctrl+B）
```

> ⚠️ 顺序不能反：先 `npm install` 再「构建 npm」。
> 只点「构建 npm」而不先对齐 `node_modules`，就会重演上面的事故。

**校验（可选，30 秒）**：`miniprogram_npm/@vant/weapp` 应当是

- 一级子目录 **72** 个、文件 **466** 个、体积约 **447.3 KB**；
- 且与 `node_modules/@vant/weapp/lib` **逐字节一致**。

若数字对不上（例如 313 文件 / 366.4 KB），说明产物是 1.2.2 的，页面迟早会报错。

---

## 五、出事时的恢复步骤

1. `cd bread-main; npm install`（把 `node_modules` 拉回 1.11.7）；
2. 删掉 `miniprogram_npm/@vant/weapp` 整个目录；
3. 开发者工具里重新点「构建 npm」，再点「编译」；
4. 真机必须**重新点「预览」**生成新二维码——旧二维码对应的是坏包。

> 补充：`miniprogram_npm/` 已被 `.gitignore` 排除，它不在版本控制里，
> 所以**只能靠上面的步骤重建**，不能从 Git 恢复。
