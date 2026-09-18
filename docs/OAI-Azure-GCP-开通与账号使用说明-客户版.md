# OpenAI 官方 API / Azure / GCP 开通与使用说明（客户版）

> 本文面向客户，介绍三种主流大模型 API 开通方式的差异、开通要求与日常使用方式，便于选型与对接。  
> 具体商务条件（折扣、付款、税点、额度档位）以双方合同约定为准。

---

## 一、三种方式对比

| 维度 | OpenAI 官方 API（OAI） | Azure（Azure OpenAI / AI Foundry） | GCP（Vertex AI / Gemini） |
|------|------------------------|--------------------------------------|---------------------------|
| 官方入口 | platform.openai.com | portal.azure.com / ai.azure.com | console.cloud.google.com |
| 计费方式 | 平台预充值 / 账单扣费 | 云订阅账号账单（按用量） | 云项目结算账号账单（按用量） |
| 您将获得 | 组织/项目权限 + API Key | 云账号登录信息 + Endpoint + Key | 云账号登录信息 + 调用凭证 |
| 适用场景 | 需要直连 OpenAI 原生 API | 需要企业云合同、发票与账号管理 | 需要 Gemini / Google 云生态 |
| 中国大陆说明 | 官方平台通常无法直接服务中国大陆主体 | 可通过企业云订阅合规开通（视区域与模型而定） | 同左，视结算主体与区域而定 |

---

## 二、OpenAI 官方 API（OAI）

### 2.1 简介

OpenAI 官方 API 平台，入口：https://platform.openai.com/home  
调用走 OpenAI 原生接口，不经过 Azure / GCP。

### 2.2 开通流程

1. 注册并登录 OpenAI 账号，创建组织（Organization）。
2. 按官网要求完成身份与支付方式验证。
3. 在 Billing 中充值或绑定付款方式。
4. 创建项目（Project），生成 API Key。
5. 配置用量限额与告警后即可调用。

### 2.3 开通要求

| 项目 | 说明 |
|------|------|
| 主体与支付 | 需官网支持的主体与支付能力；中国大陆主体通常难以直接开通 |
| 资金 | 以预充值为主，余额不足将影响调用 |
| 合规 | 请仅使用官方正规渠道；异常低价的非官方资源存在封禁与合规风险，不建议使用 |

### 2.4 使用方式

- 使用 API Key 调用官方接口（Base URL 以官方文档为准，一般为 `api.openai.com`）。
- 费用从平台余额或账单中扣除。
- 建议生产与测试环境使用不同 Key，并设置月度限额。

---

## 三、Azure（Azure OpenAI / AI Foundry）

### 3.1 简介

在 Microsoft Azure 订阅内使用 Azure OpenAI / AI Foundry。  
管理入口：https://portal.azure.com/  
模型与项目管理：https://ai.azure.com/

费用记在 **Azure 云账号订阅** 上，属于账号制使用，而非 OpenAI 平台预充值。

### 3.2 开通流程（由我方协助开通时）

1. 您提出开通需求，并确认商务条件（折扣、付款方式、税务安排等）。
2. 确认账号额度规模（常见参考档位：15K / 30K / 50K / 1M 美金，具体以合同为准）。
3. 我方完成开号。
4. 向您交付 **账号与密码**（以及必要的资源说明）。
5. 您登录 Azure Portal / AI Foundry，部署模型并获取 Endpoint 与 Key 后开始调用。

若您已有自有 Azure 订阅，也可自行创建资源并部署模型；我方可提供技术协助。

### 3.3 开通要求

| 项目 | 说明 |
|------|------|
| 商务条件 | 需事先确认折扣、付款（预付/账期等）、开票与税务安排 |
| 账号额度 | 最低付款与可用规模取决于您需要的账号体量 |
| 使用规范 | 遵守 Microsoft 与模型提供方的服务条款与可接受使用政策 |

### 3.4 使用方式

1. 使用交付的账号登录 Azure Portal 或 AI Foundry。
2. 在订阅中查看资源、模型部署、密钥与 Endpoint。
3. 通过 Endpoint + API Key 调用；企业场景也可配置 Microsoft Entra ID 鉴权。
4. 用量计入该订阅账单，按约定结算。

**安全建议：** 首次登录后请及时修改密码、开启 MFA，并为开发人员分配最小权限子账号，避免长期共用主账号。

### 3.5 控制台中常见信息

- API Key  
- Project Endpoint  
- Azure OpenAI Endpoint（形如 `*.openai.azure.com`）  
- 已部署或可选用的模型列表  

---

## 四、GCP（Vertex AI / Gemini）

### 4.1 简介

在 Google Cloud 项目中通过 Vertex AI 使用 Gemini 等模型。  
入口：https://console.cloud.google.com/  

计费挂在 GCP 结算账号与项目上，开通与使用逻辑与 Azure 类似，同属 **云账号制**。

### 4.2 开通流程（由我方协助开通时）

1. 提出需求并确认商务条件（折扣、付款、税务）。
2. 确认账号/项目额度规模。
3. 我方开号并交付账号密码及相关项目信息。
4. 您登录 Google Cloud Console，启用 Vertex AI，配置调用凭证后开始使用。

### 4.3 开通要求

| 项目 | 说明 |
|------|------|
| 结算账号 | 需有效 Billing Account，预付或企业协议以合同为准 |
| 商务条件 | 折扣、付款、税点需提前确认 |
| 区域与模型 | 不同区域可开通的模型与配额可能不同 |

### 4.4 使用方式

- 登录 Cloud Console 管理项目与配额。
- 通过 Vertex AI SDK / REST 调用；常用服务账号密钥或工作负载身份鉴权。
- 费用按项目用量计入结算账号。
- 建议主账号仅作管理用途，日常调用使用独立服务账号，并定期轮换密钥。

---

## 五、协作开通流程（Azure / GCP）

```text
提出开通需求
  → 确认商务条件（折扣 / 付款 / 税）
  → 确认账号额度规模
  → 完成开号
  → 交付账号与密码
  → 您登录控制台，部署/启用模型，获取 Endpoint 与调用凭证
  → 按约定充值或消耗额度
```

OpenAI 官方 API 一般不走「云账号密码」交付，而是平台账号 + 预充值 + API Key。

---

## 六、如何选择

| 您的需求 | 建议方向 |
|----------|----------|
| 需要 OpenAI 原生 API，且具备海外支付与平台充值条件 | OpenAI 官方 API |
| 需要企业合同、发票、账号统一管理，接受 Azure 生态 | Azure |
| 需要 Gemini 或已有 Google Cloud 环境 | GCP |
| 来源不明、价格异常偏低的非官方渠道 | 不建议，存在封号与合规风险 |

---

## 七、交付验收清单（供您核对）

### OpenAI 官方 API

- [ ] 组织 / 项目已就绪  
- [ ] 账单/余额可正常扣费  
- [ ] API Key 已获取并完成试调用  
- [ ] 已设置用量限额与告警  

### Azure

- [ ] 可使用账号密码登录 Portal / Foundry  
- [ ] 订阅状态正常，额度与付款约定清晰  
- [ ] 模型已部署（或已知部署步骤）  
- [ ] Endpoint 与 Key（或企业鉴权）验证通过  
- [ ] 已完成改密与 MFA 等安全设置  

### GCP

- [ ] 可登录 Console，项目已关联结算账号  
- [ ] Vertex AI 等相关 API 已启用  
- [ ] 调用凭证已就绪并完成试调用  
- [ ] 区域与配额满足业务需求  
- [ ] 已完成安全与权限设置  

---

## 八、官方链接

| 平台 | 链接 |
|------|------|
| OpenAI Platform | https://platform.openai.com/home |
| Azure Portal | https://portal.azure.com/ |
| Azure AI Foundry | https://ai.azure.com/ |
| Google Cloud Console | https://console.cloud.google.com/ |

---

如需报价、开号或技术对接，请联系您的商务对接人。具体条款以书面合同为准。
