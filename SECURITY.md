# 安全问题反馈

请通过 [GitHub 私密漏洞报告](https://github.com/hexf11/ChainTrace/security/advisories/new)
提交涉及 RPC 凭据泄露、权限绕过或消息校验的问题。不要将漏洞利用细节或真实凭据放进公开 Issue。

报告中请提供扩展版本、Chrome 版本、复现步骤、预期行为和实际行为。
请使用脱敏的 RPC 地址和测试数据。维护者优先处理最新发布版本的问题。

扩展仅提供只读查询，不连接钱包、不签名、不发送交易。
RPC 服务会收到所查询的交易签名和区块号；Jito 索引会收到区块号。
完整数据流与权限说明见 [架构说明](docs/ARCHITECTURE.md)。
