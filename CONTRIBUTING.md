# 参与 ChainTrace

欢迎提交问题、页面适配和 Pull Request。请先查找已有 Issue，描述具体行为和预期结果。

## 本地开发

使用 Node.js 22 或更高版本、npm 和 Python 3：

```sh
npm ci
npx playwright install chromium
npm run check
npm test
npm run test:browser
npm run package
```

Linux 上安装浏览器依赖可使用 `npx playwright install --with-deps chromium`。
扩展本身无需构建，直接在 `chrome://extensions` 加载仓库根目录。

## 提交变更

- 保持自动查询和活动列表内展示；RPC 弹窗仅用于节点设置。
- Bundle 标记必须有明确的 Jito 索引记录，并核对完整成员的区块位置与顺序。
- 只对当前同一活动列表中可见至少两笔不同签名的成员画 Bundle 框；单笔提交、独立 tip 和重复活动不能凑数。
- 不将同 Slot、相邻 Index、同钱包或 tip 转账视为 bundle 归属证据。
- RPC 地址和凭据留在扩展内。不要添加钱包签名、交易发送或任意 URL 代理。
- 为行为变更提供能复现问题的测试；调整 UI 时附上使用测试数据的截图。
- PR 描述说明触发条件、变更后的行为和验证结果。

浏览器测试使用独立临时配置，并拦截 GMGN、Solana RPC 与 Jito 请求。
不要在测试、Issue、截图或日志中加入个人 RPC key、Cookie、助记词或私钥。

## 发布

同步修改 `manifest.json` 和 `package.json` 的版本，运行 `npm install --package-lock-only` 更新锁文件。
所有检查通过后运行 `npm run package`，将 `dist/chaintrace-chrome.zip` 和 `dist/SHA256SUMS`
附到对应版本的 GitHub Release。发布包由明确的文件清单生成，不包含依赖、测试和本地配置。

贡献的代码采用本项目的 [MIT 许可证](LICENSE)。
