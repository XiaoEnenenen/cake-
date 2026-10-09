/**
 * 数据源配置（唯一事实来源）
 * ---------------------------------------------------------------------------
 * 2026-10-09 阶段三改造：数据源收敛为**单一通道** —— 微信云开发（cloudfunctions/api）。
 *
 * 阶段一遗留的另外两条通道已彻底删除：
 *   1. Mock（utils/mock-backend.js）
 *      从未实现过（mock-backend.js 早已归档），只留下一个永远返回 501 的占位。
 *   2. api 工厂（apifm-wxapi SaaS，config.js 指向**原面包店**的 api 工厂账号）
 *      连同「云函数失败自动降级」一起移除（config.js 已随本次改造归档）。
 *      删除理由（见 audit/A-启动与数据层.md）：
 *        A-P0-01  降级通道在云模式下从未 init，请求打到 api.it120.cc/-/ 拿不到数据；
 *                 而一旦有人补上 WXAPI.init(config.subDomain)，orderCreate / cartAdd
 *                 就会把**顾客订单与购物车写进原面包店账号**——串号风险。
 *        A-P1-01  降级后 __dataSource() 不再是 'cloud'，isCloudMode() 永久失效，
 *                 鉴权改读从不存在的 storage.token → 用户看到「无法登录」。
 *        A-P1-02  云函数把业务异常也返回 500，降级判定把「一次数据库报错」
 *                 当成「环境不可用」，于是**静默换源**。
 *
 * 现在只有一条路：
 *   pages / components → utils/api-map.js → wx.cloud.callFunction('api') → cloudfunctions/api
 *
 * 云函数不可用（未部署 / 未开通云开发 / 网络异常）时，页面拿到的是
 * { code: 500, msg: '云函数调用失败' } 这类明确错误，**不再有任何备用数据源**，
 * 也不会把顾客数据写到别处。排查方向只有一个：云环境与 cloudfunctions/api 的部署状态。
 * ---------------------------------------------------------------------------
 */
module.exports = {
  // ===== 数据源（唯一开关）=====
  // 全项目只有「微信云开发」一个数据源，本开关保留为**显式声明**，不再是三态选择器：
  //   - utils/api-map.js 用它决定是否执行 wx.cloud.init，并在被误设为 false 时明确报错；
  //   - utils/auth.js 的 isCloudMode() 用它作为唯一判据（不再依赖 __dataSource() 字符串）。
  // ⚠️ 不存在「第二个数据源」：改成 false 只会得到「数据源未启用」的报错，不会切到别的通道。
  useCloud: true,

  // ===== 云函数配置 =====
  // 云函数名（部署时保持一致，见 cloudfunctions/api）
  cloudFunctionName: 'api',

  // 云开发环境 ID（★ 多环境部署：必须显式指定，不要依赖"默认环境"）
  //
  // 为什么必须填：
  //   本店采用多环境方案（例如 dev / prod 分开）。wx.cloud.init 不传 env 时
  //   会使用「开发者工具当前选中的环境」，容易出现"本地连了 dev、真机连了 prod"
  //   这种数据错乱，且云端环境切换不会体现在代码里，排查困难。
  //
  // 怎么填：
  //   微信开发者工具 → 云开发 → 环境 → 环境设置，复制「环境 ID」
  //
  // 当前值（2026-09-26 初始化，个人测试 AppID）：
  //   AppID   : wx5b0e027deafefc01
  //   环境 ID : cloud1-d7g2txuxpf22bb979
  //
  // ⚠️ 换企业 AppID 时（阶段 6），这里必须改成企业环境 ID，并同步改 project.config.json 的 appid。
  //    留空 '' 时的行为 = 使用开发者工具当前选中的默认环境（多环境下不推荐）。
  cloudEnvId: 'cloud1-d7g2txuxpf22bb979',

  // 环境 ID 待填入时，是否在小程序启动时打印一条提醒（方便发现"忘了配环境"）
  warnOnEmptyEnvId: true,

  // ===== 调试 =====
  // 是否在控制台打印数据层调用日志
  debug: false
}
