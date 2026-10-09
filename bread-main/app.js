// ⚠️ 本文件的 apifm-wxapi 为 legacy 备用通道依赖，与 utils/services/legacy-apifm.js 同属备用路径。
//    原因：app.js 是启动入口，且 legacy 分支需要 init/setMerchantId 这类"未收敛到 api-map 的初始化调用"，
//    为保持入口可读性不改为间接引用。主流程（云开发 / Mock）不会走到这些调用。
//    详见 utils/services/legacy-apifm.js 顶部说明。
const WXAPI = require('apifm-wxapi')
const AUTH = require('utils/auth')
const CONFIG = require('config')
const DS = require('utils/data-source')
const API = require('utils/api-map')
App({
  onLaunch: function () {
    // ===== 改造：按数据源初始化（三态，2026-09-26 阶段一）=====
    // useMock  = true → 本地假数据，无需初始化任何后端
    // useCloud = true → 自建云开发（★ 主路线），必须调用 API.init()（内部执行 wx.cloud.init）
    // 两者都 false    → legacy 备用通道，初始化 api工厂 SDK（保持改造前行为）
    if (DS.useMock) {
      // Mock 模式：不初始化任何后端
    } else if (DS.useCloud) {
      API.init()
    } else {
      WXAPI.init(CONFIG.subDomain)
      WXAPI.setMerchantId(CONFIG.merchantId)
    }
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
    // ===== 改造：店铺配置来源 =====
    // 门店名以 shop-config.js 为唯一事实来源。
    //
    // ⚠️ 踩过的坑：原逻辑从 api工厂 后台拉 mallName 并写入 storage，
    //    而 config.js 目前仍指向原店铺账号，导致会把【原店名】写进 mallName，
    //    首页/会员卡/关于我们等页面的导航栏标题都会显示原店名。
    //    因此这里加了一道保护：拉取后台配置后，再用 shop-config 的门店名覆盖回去。
    //    待 config.js 换成自己的账号、或 useCloud 改为 true 后，该保护可保留亦可移除。
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

    if (DS.useMock) {
      // Mock 模式：不请求任何后端配置，直接用本地门店配置
      if (configuredShopName) {
        wx.setStorageSync('mallName', configuredShopName)
      }
      afterConfigLoaded()
    } else if (DS.useCloud) {
      // 云开发模式：调统一数据层的 appConfig（云函数 action appConfig），
      // 把 mallName / order_remark_msg / order_hx_uids 写入 storage，与 api工厂 行为一致。
      // 云开发模式下店铺名同样以本地配置为准，避免被后端值覆盖。
      API.appConfig().then(res => {
        if (res && res.code == 0 && Array.isArray(res.data)) {
          res.data.forEach(config => {
            // 跳过 mallName：由上面的保护逻辑统一赋值，防止显示原店名
            if (config.key === 'mallName') return
            wx.setStorageSync(config.key, config.value);
          })
        }
        afterConfigLoaded()
      }).catch(() => {
        // 云函数不可用时也要保证标题正确
        afterConfigLoaded()
      })
    } else {
      // https://www.yuque.com/apifm/nu0f75/dis5tl
      WXAPI.queryConfigBatch('mallName,order_remark_msg,order_hx_uids').then(res => {
        if (res.code == 0) {
          res.data.forEach(config => {
            // 跳过 mallName：由上面的保护逻辑统一赋值，防止显示原店名
            if (config.key === 'mallName') return
            wx.setStorageSync(config.key, config.value);
          })
        }
        afterConfigLoaded()
      }).catch(() => {
        // 后台不可用时也要保证标题正确
        afterConfigLoaded()
      })
    }
  },
  onShow(e){
    // 2026-09-26 阶段二：已删除三级分销（邀请人/裂变）相关逻辑。
    // 删除内容：storage.referrer 写入、wx.getShareInfo + wx.login + WXAPI.shareGroupGetScore 裂变埋点。
    // 说明：本店不做分销，且该段依赖 api 工厂 SaaS（云开发模式下不可用）。
    //
    // 自动登录（云开发模式下 AUTH.checkHasLogined 会走 OPENID 分支）
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