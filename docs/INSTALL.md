# 安装链序 ChainTrace

1. 解压 `chaintrace-chrome.zip`，保留其中的 `chaintrace-chrome` 文件夹。
2. 在 Chrome 地址栏打开 `chrome://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择包含 `manifest.json` 的文件夹。
4. 刷新 GMGN 的 Solana 代币详情页，活动列表会自动显示 Slot / Index。
5. 点击工具栏的链序图标即可设置 RPC。保存后自动应用到已打开的页面。

需要 Chrome 111 或更高版本。通过源码安装时，直接加载仓库根目录，无需构建。
扩展目录需要保留；更新时覆盖原目录里的文件，在扩展管理页点击刷新，再刷新 GMGN。
沿用同一安装路径可保留原有扩展设置。

## 使用

- 页面中可见的交易依次自动查询，滚动到新交易会继续查询。
- 切换到 1s K 线，点击蜡烛图即可自动定位和查询该秒的活动。
- 「同笔」框表示相同 Slot / Index 的多条活动记录。
- 金色「Jito Bundle」框表示 Jito 索引明确收录、且完整成员与区块核对通过的交易组。
- 点击 Jito Bundle 标记可打开 Jito Explorer。没有标记表示尚未确认归属。

默认公共 RPC 可能限流或缺少历史数据。自定义主网节点需支持 `getGenesisHash`、
`getSignatureStatuses`、`getTransaction` 和 `getBlock`。

项目与更新：https://github.com/hexf11/ChainTrace
