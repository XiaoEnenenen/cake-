// 2026-10-09 阶段三：本文件不再 require apifm-wxapi / config ——
// api 工厂降级通道（含 bread-main/config.js 里的原店账号）已整体删除，
// 启动时只初始化云开发这一条数据源。
const AUTH = require('utils/auth')
const API = require('utils/api-map')
// 2026-10-17 顾客反馈：退出登录后再次打开小程序要重新弹隐私政策（见 utils/privacy.js）
const PRIVACY = require('utils/privacy')
App({
  onLaunch: function () {
    // ===== 退出登录后的"重新告知隐私"（2026-10-17 第二轮顾客反馈）=====
    // 退出登录时只写了一个标记；这里在**下次冷启动**才真正清掉同意/已提示状态，
    // 于是首页的隐私弹窗会重新出现；如果退出后又马上登录，登录弹层会取消这个标记。
    PRIVACY.consumeResetOnNextLaunch()
    // ===== 数据源初始化（阶段三：只有云开发一条通道）=====
    // API.init() 内部执行 wx.cloud.init（环境取自 utils/data-source.js 的 cloudEnvId）。
    // 云函数不可用时页面会拿到明确的「云函数调用失败」，不会降级到任何备用数据源。
    API.init()
    // ===== 改造：移除外链字体加载 =====
    // 原逻辑：从第三方 CDN ns.s2m.cc 加载 LxgwWenKai 字体，属于原项目作者的资源，
    //        非本店可控（可能失效/被墙），且会拖慢启动。
    // 现改为使用系统字体栈，已在 app.wxss 中配置 PingFang SC / 微软雅黑 等回退。
    // 恢复方式：取消下方注释即可（需自行确保字体文件可访问）。
    //
    // wx.loadFontFace({
    //   global: true,
    //   family: 'LxgwWenKai',
    //   source: 'url("https://ns.s2m.cc/xwwk.ttf")'
    // })
    // ===== 改造结束 =====
    // 检测新版本
    const updateManager = wx.getUpdateManager()
    updateManager.onUpdateReady(function () {
      wx.showModal({
        title: '更新提示',
        content: '新版本已经准备好，是否重启应用？',
        success(res) {
          if (res.confirm) {
            // 新的版本已经下载好，调用 applyUpdate 应用新版本并重启
            updateManager.applyUpdate()
          }
        }
      })
    })
    // ===== 店铺配置来源 =====
    // 门店名以 shop-config.js 为唯一事实来源（与云函数 cloudfunctions/api/shop-config.js 同源）。
    //
    // 保留的保护逻辑：店铺名不从后端取值。
    // 历史原因（阶段三之前）：能从后台拉到的 mallName 属于原面包店账号；
    // 现在 config.js 与 api 工厂通道都已删除，这条保护仍然有效——
    // 它保证「无论 app_config 集合里写了什么，导航栏标题都是本店的名字」。
    const SHOP_CONFIG = require('shop-config')
    const configuredShopName = SHOP_CONFIG.shop && SHOP_CONFIG.shop.name

    const afterConfigLoaded = () => {
      // 关键保护：门店名始终以本店配置为准，避免被后台的原店名覆盖
      if (configuredShopName) {
        wx.setStorageSync('mallName', configuredShopName)
      }
      if (this.configLoadOK) {
        this.configLoadOK()
      }
    }

    // 云开发模式：调统一数据层的 appConfig（云函数 action appConfig），
    // 把 mallName / order_remark_msg / order_hx_uids 写入 storage。
    // 店铺名同样以本地配置为准，避免被后端值覆盖。
    API.appConfig().then(res => {
      if (res && res.code == 0 && Array.isArray(res.data)) {
        res.data.forEach(config => {
          // 跳过 mallName：由上面的保护逻辑统一赋值，防止显示后台里的店名
          if (config.key === 'mallName') return
          wx.setStorageSync(config.key, config.value);
        })
      }
      afterConfigLoaded()
    }).catch(() => {
      // 云函数不可用时也要保证标题正确
      afterConfigLoaded()
    })
  },
  onShow(e){
    // 2026-09-26 阶段二：已删除三级分销（邀请人/裂变）相关逻辑。
    // 删除内容：storage.referrer 写入、wx.getShareInfo + wx.login + 原 api 工厂的 shareGroupGetScore 裂变埋点。
    // 说明：本店不做分销，且该段依赖 api 工厂 SaaS（云开发模式下不可用）。
    //
    // 自动登录（云开发模式下 AUTH.checkHasLogined 会走 OPENID 分支）
    // 阶段 12：用户主动「退出登录」后，本次启动不再自动建立/刷新登录态；
    // 资料由「我的」页点「登录」时重新拉取（底层 openid 仍由微信自动注入，不影响下单）。
    let loggedOut = false
    try {
      loggedOut = wx.getStorageSync('loggedOut') === '1'
    } catch (e) {
      loggedOut = false
    }
    if (loggedOut) return
    AUTH.checkHasLogined().then(isLogined => {
      if (!isLogined) {
        AUTH.login()
      }
    })
  },
  tabbarChange(e, curIndex) {
    if (e.detail == curIndex) {
      return
    }
    const pages = [
      '/pages/index/index',
      '/pages/orders/index',
      '/pages/current-order/index',
      '/pages/my/index',
    ]
    wx.reLaunch({
      url: pages[e.detail]
    })
  },
})