# 官方 API（OAI）/ Azure / GCP：开通流程、要求与账号使用方式

> 整理说明：结合官方开通方式，以及当前商务侧对接口径（账号申请 → 定商务条件 → 开号 → 交付账号密码）。  
> 面向内部售前 / 交付，不替代各云厂商最新官方文档。

---

## 一、三种方式总览

| 维度 | 官方 OAI（OpenAI Platform） | Azure（Azure OpenAI / AI Foundry） | GCP（Vertex AI / Gemini） |
|------|-----------------------------|--------------------------------------|---------------------------|
| 入口 | [platform.openai.com](https://platform.openai.com/home) | [portal.azure.com](https://portal.azure.com/) / [ai.azure.com](https://ai.azure.com/) | [console.cloud.google.com](https://console.cloud.google.com/) |
| 计费形态 | **预充值**（平台 Credits / Billing） | **账号订阅制账单**（按用量记在 Azure 订阅） | **账号项目制账单**（按用量记在 GCP 项目/结算账号） |
| 典型交付物 | API Key + 组织/项目权限 | **账号 + 密码**（订阅/资源组/部署）+ Endpoint + Key | **账号 + 密码**（项目/服务账号）+ Endpoint / Key / ADC |
| 中国大陆可用性 | 官方平台**不可直接服务中国大陆**；折扣也无大陆官方渠道 | 可通过合规企业订阅开通（区域、模型、配额视订阅与区域而定） | 同理，视结算主体、区域与模型可用性而定 |
| 折扣来源 | 仅 **OpenAI 官方**（海外少量折扣）；市场报 **9 折以下** 多属违规/黑产资源 | 商务谈折扣、付款、税 | 商务谈折扣、付款、税 |
| 开通难度（商务侧） | 需海外支付与身份能力，对客户门槛更高 | **相对简单**：定商务条件后开号交付 | **同理**：定商务条件后开号交付 |

---

## 二、官方 OAI（OpenAI API Platform）

### 2.1 是什么

- OpenAI **官方 API 平台**（常称 OAI）。
- 入口：`https://platform.openai.com/home`
- 属于 OpenAI 官方产品，**不走** Azure / GCP 转售通道。

### 2.2 开通流程（官方侧）

1. 注册 / 登录 OpenAI 账号（组织 Organization）。
2. 完成身份与支付能力校验（海外手机、海外卡或官方支持的支付方式等，以官网当时要求为准）。
3. 在 Billing 中 **充值 / 绑定付款方式**（预付费额度为主）。
4. 创建 Project，生成 **API Key**。
5. 按模型开通用量、设置限额与告警。

### 2.3 要求

| 项 | 说明 |
|----|------|
| 主体 | 个人或企业组织；中国大陆主体通常无法直接走官方通路 |
| 支付 | 需可被官方接受的支付方式；**依赖充值** |
| 折扣 | 折扣来自 **OpenAI 官方**；中国大陆 **没有** 官方折扣渠道 |
| 海外折扣 | 海外可有少量官方折扣；若市场报价 **低于约 9 折**，**大概率为违规资源（黑产来源）**，勿作为合规交付方案 |
| 合规 | 禁止转售未授权 Key、共享违规账号、绕过区域与 ToS 限制 |

### 2.4 账号使用方式

- **使用主体**：客户持有 Platform 上的 Org / Project。
- **调用方式**：用 API Key 直连 `api.openai.com`（或官方文档指定的 Base URL）。
- **计费**：扣平台预充值余额 / 账单；用完需再充。
- **权限**：Key 可按 Project 隔离；建议生产与测试分 Key，并设月度硬限额。
- **交付形态（若对外售卖）**：一般交付的是 **可用额度的官方账号体系 + Key**，而不是「云订阅账号密码」模式；需特别注意 ToS 是否允许代持/转售。

### 2.5 商务侧注意

- 适合：必须用 **OpenAI 原生端点 / 最新模型同步更快** 的客户。
- 不适合：无法海外支付、强合规要求只能走企业云合同的客户。
- 风控话术：低于官方合理折扣的「OAI 批发价」默认按 **高风险资源** 处理。

---

## 三、Azure（Azure OpenAI / Microsoft Foundry）

### 3.1 是什么

- 在 **Microsoft Azure** 订阅内开通 Azure OpenAI / AI Foundry 等能力。
- 管理入口：`https://portal.azure.com/`
- 开发与模型管理常见入口：`https://ai.azure.com/`（Foundry）
- 计费挂在 **Azure 账号/订阅** 上，不是 OpenAI Platform 预充值。

### 3.2 开通流程

#### A. 官方自助（客户自己有订阅时）

1. 注册 / 登录 Azure，创建订阅并绑卡或企业协议。
2. 创建资源组 → 创建 Azure OpenAI / AI 资源（选区域）。
3. 在 Foundry / Azure OpenAI 中 **部署模型**（Deployment）。
4. 获取：
   - Azure OpenAI Endpoint（如 `https://xxx.openai.azure.com/openai/v1/`）
   - API Key 或 Entra ID（AAD）鉴权
5. 按部署名调用；设置配额、网络（可选 Private Endpoint）、监控。

#### B. 当前商务交付口径（代开 / 渠道开号）

与对接方约定流程一致：

1. **客户侧向我方申请账号**，并 **定好商务条件**（折扣、付款、税等）。
2. 我方按条件 **开号**。
3. 将 **账号 + 密码** 交付给客户（客户再用该账号进 Portal / Foundry 使用）。

> 要点：**Azure 是账号支付**——费用走订阅账单；交付核心是「云账号」，不是单独卖一把 OAI Key。

### 3.3 要求（商务条件）

商务条件通常围绕三块谈定：

| 条件 | 说明 |
|------|------|
| 折扣 | 相对公有价的商务折扣 |
| 付款 | 预付 / 账期等；**最低付款额与账号体量相关** |
| 税 | 开票主体、税率、跨境税务安排 |

**账号体量（额度档位，单位：美金 USD）**（对接口径示例）：

| 档位 | 含义（交付侧） |
|------|----------------|
| 15K | 较小用量账号 |
| 30K | 中等 |
| 50K | 较大 |
| 1M | 超大 / 企业级 |

具体以当时合同与云厂商政策为准；「最少付多少」取决于要交付给客户的 **账号规模**。

### 3.4 账号使用方式

- **登录**：客户使用交付的 Azure 账号登录 Portal / Foundry。
- **资源**：在订阅下查看资源、部署、密钥、项目 Endpoint。
- **调用**：
  - 使用资源 Endpoint + Key；或
  - 企业场景用 Microsoft Entra ID 鉴权。
- **计费**：用量计入该 Azure 订阅；由账号侧支付（预存额度或账单结算，按开号约定）。
- **权限建议**：交付后尽快改密、开启 MFA、按最小权限建子账号 / SP，避免长期共用主账号密码。

### 3.5 示例（界面侧会看到的信息）

在 AI Foundry 一类控制台中，通常可见：

- 掩码显示的 API Key
- Project Endpoint
- Azure OpenAI Endpoint（`*.openai.azure.com`）
- 已部署 / 可探索的模型列表（OpenAI、以及其他厂商模型视订阅而定）

---

## 四、GCP（Vertex AI / Gemini API）

### 4.1 是什么

- 在 **Google Cloud** 项目中开通 Vertex AI，调用 Gemini 等模型（以及 Vertex 上的其他模型）。
- 入口：Google Cloud Console。
- 计费挂在 **GCP 结算账号 + 项目**，逻辑与 Azure 同属 **云账号制**，不是 OAI 平台预充值。

### 4.2 开通流程

#### A. 官方自助

1. 注册 Google 账号 / Cloud Identity，创建 GCP 项目。
2. 绑定 Billing Account（结算账号）。
3. 启用 Vertex AI API 等相关 API。
4. 配置区域、配额；创建服务账号或使用 API Key（视产品线而定）。
5. 通过 Vertex AI Endpoint / Gemini API 调用。

#### B. 商务交付口径

与 Azure **同理**：

1. 申请账号并定商务条件（折扣、付款、税）。
2. 开号。
3. 交付 **账号 + 密码**（及项目/结算相关信息）给客户。

### 4.3 要求

| 项 | 说明 |
|----|------|
| 结算 | 有效 Billing Account；企业协议或预付视商务约定 |
| 商务条件 | 同样谈 **折扣 / 付款 / 税**；额度档位可按客户交付规模谈（可与 Azure 档位对照沟通） |
| 区域与模型 | Gemini / 第三方模型可用性因 region 与项目资质而异 |
| 合规 | 遵守 Google Cloud / 模型提供方 AUP；勿使用来路不明的「打折 GCP」 |

### 4.4 账号使用方式

- **登录**：Cloud Console 账号。
- **调用**：Vertex AI SDK / REST；鉴权常用服务账号 JSON 或工作负载身份，部分场景可用 API Key。
- **计费**：项目用量 → 结算账号出账。
- **权限建议**：主账号仅作接管；日常用 IAM 最小权限服务账号，密钥轮换。

---

## 五、商务开号通用流程（Azure / GCP）

适用于云账号制交付（与当前对接话术一致）：

```text
客户申请账号
    → 定商务条件（折扣 / 付款 / 税）
    → 确认账号体量（如 15K / 30K / 50K / 1M USD）
    → 我方开号
    → 交付账号密码给客户
    → 客户登录云控制台部署模型 / 取 Endpoint 与 Key
    → 按约定充值或消耗额度
```

OAI 官方通道 **不走** 上述「云账号密码」主路径，而是 Platform 注册 + 充值 + API Key。

---

## 六、怎么选（简表）

| 客户诉求 | 更合适 |
|----------|--------|
| 只要官方 OpenAI 原生 API、接受海外支付与预充值 | **OAI** |
| 要企业合同、发票、账号制、可谈折扣；接受 Azure 生态 | **Azure** |
| 要 Gemini / Google 生态或已有 GCP | **GCP** |
| 只要「很低的 OAI 折上折」且来源不清 | **不做**（违规风险） |

---

## 七、交付检查清单

### OAI

- [ ] 组织 / 项目已创建  
- [ ] Billing 已充值且可扣费  
- [ ] API Key 已生成并完成一次试调用  
- [ ] 限额与告警已设  
- [ ] 已向客户说明：非中国大陆官方折扣渠道；异常低价资源不可用  

### Azure

- [ ] 商务与账号密码已交付，客户可登录 Portal / Foundry  
- [ ] 订阅状态正常，额度 / 付款约定清晰  
- [ ] 模型已部署（或客户已知如何部署）  
- [ ] Endpoint + Key（或 Entra 方案）已验证  
- [ ] 已提醒改密、MFA、权限拆分  

### GCP

- [ ] 账号可登录 Console，项目与 Billing 已关联  
- [ ] Vertex AI（及所需 API）已启用  
- [ ] 调用凭证（服务账号等）已交付且试调用成功  
- [ ] 配额与区域符合客户模型需求  
- [ ] 已提醒改密、MFA、密钥轮换  

---

## 八、相关链接

| 平台 | 链接 |
|------|------|
| OpenAI Platform | https://platform.openai.com/home |
| Azure Portal | https://portal.azure.com/ |
| Azure AI Foundry | https://ai.azure.com/ |
| Google Cloud Console | https://console.cloud.google.com/ |

---

## 修订记录

| 日期 | 说明 |
|------|------|
| 2026-03-18 | 初版：汇总 OAI / Azure / GCP 开通、要求、使用方式及商务开号口径 |
