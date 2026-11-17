# 架构与数据边界

ChainTrace 是 Chrome Manifest V3 扩展，无运行时第三方依赖。

| 文件 | 职责 |
| --- | --- |
| `page.js` | 在 MAIN 环境观察图表和活动数据，维护自动查询队列，在活动行展示结果 |
| `content.js` | 在 ISOLATED 环境转发限定的设置、RPC 和 bundle 查询消息 |
| `background.js` | 校验来源与参数，读取节点设置，执行跨域请求、缓存和限速 |
| `options.html` / `options.js` / `options.css` | 工具栏 RPC 设置弹窗 |
| `styles.css` | Slot / Index 列、同笔与 Jito Bundle 框线 |

## Slot / Index

可见行按出现顺序加入队列，分批查询交易状态，再串行解析区块位置。
滚动、虚拟列表复用、列表更新都会发现新签名；没有 200 笔的总查询上限。
`getBlock` 使用 `finalized` 和 `transactionDetails: signatures`，Index 是完整区块中从 0 开始的位置。
交易状态与区块数据使用缓存，失败项按退避时间重试。
切换代币或修改 RPC 会使旧任务失效，避免旧结果写入新页面。

同 Slot、同 Index 的多条活动属于同一笔链上交易。框线按视觉顺序绘制，
不移动或包装 GMGN 的行节点；不相邻的同组记录分段展示。

## Bundle 确认

数据源为 Jito Explorer 当前使用的公开 GET 接口：
`https://bundles.jito.wtf/api/v1/bundles/slot/{slot}`。

1. 校验 bundle ID、Slot、时间与完整成员签名，拒绝格式错误和冲突记录。
2. 将每个成员签名与 RPC 返回的已最终确认区块核对。
3. 仅全部成员都存在且顺序一致时，标记为 Jito Bundle。
4. 可见成员不足全包时显示可见笔数 / 总笔数，点击标记打开官方来源。

查询按 Slot 合并、缓存并限速，不影响普通 RPC 队列。
索引缺失、延迟、超时或接口变化时保持未确认，并按退避策略重试。
不根据相邻 Index、tip 或同 Slot 推测已确认归属；此功能不覆盖全部私有或其他服务的 bundle。

测试样本 `tests/fixtures/jito-slot.json` 来自 2026-11-17 的公开 Jito 索引，
仅包含公开的链上交易与 bundle 记录。

## 权限与隐私

- 自动注入仅匹配 `https://gmgn.ai/*`、`https://www.gmgn.ai/*` 的顶层页面。
- 默认访问 Solana 公共 RPC 与 `bundles.jito.wtf`。自定义节点在保存时按域名申请可选权限。
- RPC URL 保存在 `chrome.storage.local`，不做云同步；页面只接收域名和配置版本号。
- 后台只接受 `getGenesisHash`、`getSignatureStatuses`、`getTransaction`、`getBlock` 四种只读方法。
- 网页不能指定任意请求 URL；Jito 请求只接受有效区块号。
- 网络请求不带浏览器 Cookie，不跟随重定向；RPC 超时 25 秒，Jito 超时 10 秒。
- RPC 提供商会收到查询签名、区块号和该节点的认证信息；Jito 只收到区块号。
- 扩展没有遥测、账号系统、钱包连接、签名或发送交易功能。

页面结构或图表接口变化可能需要更新适配。浏览器夹具测试不等同于覆盖所有线上页面和 RPC 服务商。

## 技术文档

- [Chrome 内容脚本与执行环境](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)
- [扩展跨域请求](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Solana getBlock](https://solana.com/docs/rpc/http/getblock)
- [Jito Bundles API](https://docs.jito.wtf/lowlatencytxnsend/#bundles-api-v1)
