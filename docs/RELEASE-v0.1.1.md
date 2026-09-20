# Release v0.1.1

> 交互式供应商配置（login）、1300 组对拍自动化守护、62 例单测、CI 双平台矩阵。

## 新增

### 交互式添加供应商（`login`）

一条向导把新供应商写进 opencode 配置，免掉手写 JSON：

```bash
apifix login opencode [名称]
```

流程：provider 名称（缺省从 baseURL 主机名派生）→ baseURL → API 格式
（OpenAI 兼容 / Anthropic / Gemini）→ API key（静默输入，永不回显）→
模型选择（自动检测 `{baseURL}/models`，5s 超时转手动）→ 设默认模型（可选）→
确认写入。命中的模型自动带出 catalog 官网规格；未收录的写最小条目，
后续 `apifix fix` 可修正。写入复用 fix 的安全管道（备份 + 原子替换 + 写后复验）。

脚本/CI 可用非交互模式：

```bash
apifix login oc myrelay --base-url https://api.example.com/v1 \
  --api-key sk-xxx --model gpt-6-astra,deepseek-flash --yes
```

`login` 是全项目唯一发起网络请求的命令（只请求用户填写的 baseURL）。

## 修复

- **UI 降级实现与 core 的 pi api 映射漂移**：`deepseek-flash` / `deepseek-v4-pro`
  的 pi 完整模式此前会丢失 `api` 字段；fallback 已外置为独立模块并逐行对齐 core 语义。
- Windows 下配置文件被占用（EPERM/EACCES）时，`fix` 现在给出针对性提示
  （文件占用/只读、备份位置、原文件未动），不再是一句笼统报错。

## 质量与工程化

- **`tools/parity-check.mjs`**：core 与 UI fallback 的 1300 组（模型数 × 2 emitter × 2 模式）
  逐字节对拍，进 CI 必跑——「双实现一致」从此自动化守护。
- **测试套件**：node:test 零依赖单测 62 例（match / emit 字节契约 / scrub 脱敏 /
  fix round-trip / tiers / format / login），进 CI 必跑。
- **CI 升级**：ubuntu + windows 双平台矩阵；冒烟 id 从 catalog 动态派生（数据演进不再假红）。
- **去重**：格式化函数（displayWidth/pad/groupThousands）与 schema 词表
  （`tools/schema.mjs`）各收敛为单一事实源。

## 安装

```bash
npm install -g github:xlong-c/apifix
apifix gpt-6-astra
```

或克隆源码直接 `node apifix.mjs <id>`（零依赖，无需 npm install）。
