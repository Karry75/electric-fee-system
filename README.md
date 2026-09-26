# 电费管理系统 · 静态看板快照

本仓库仅托管 **电费管理系统** 的静态看板快照（GitHub Pages，`main` 分支 `/docs` 目录），用于展示与分享，**不含可执行后端与数据库配置**。

## 内容

- `docs/index.html`：前端页面（对话式交互后端接口 → 改读本地 JSON，纯静态只读）
- `docs/data/*.json`：真实业务库聚合数据（已脱敏）
- `docs/js/app.js`、`docs/css/style.css`、`docs/lib/echarts.min.js`：本地静态资源（无外部 CDN 依赖）

## 数据说明

- 数据来源：生产业务库只读聚合（结算 KPI、电费预警、结算单、费用支出、商户资料统计等）
- 隐私处理：手机号 / 身份证 / 银行账号 / 凭证账号等敏感字段已掩码或移除，明细列表已截断为样例
- 站点为**只读快照**，登录、提交、导出、审核等写操作不可用

## 访问

https://karry75.github.io/electric-fee-system/
