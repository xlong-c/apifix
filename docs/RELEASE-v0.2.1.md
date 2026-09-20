# Release v0.2.1

> 配置识别改为「id 触发、锚点对齐」：只认 id / 别名 / legacy，归一化与模糊降级为建议；
> 另修复 `protocols` 的 `@ai-sdk/openai` 判定、新增厂商前缀自动并入与模型库分流。

## 行为变更（请留意）

**配置识别（`audit` / `fix` / `protocols` 读配置里的模型 id）现在只认 id / 别名 / legacy**，
链路是 `id → 模型 → 识别接口 → 修复参数`：

- 归一化写法（`glm-5.3-flash-free`、`stepfun/step-5-preview`）**不再自动套用官网规格**，
  改为提示 `最接近: X（归一化写法，未自动采用官网规格）`
- 原因：中转名字与官方名字不一致，中转变体可能是另一个型号——识别必须**锚定**。
  **中转自造的名字请在 catalog 里显式登记为 `aliases`** 做锚点（本版已锚定
  `MiniMaxAI/MiniMax-M2`、`MiniMaxAI/MiniMax-M2.1`）
- `apifix <id>` 直接查询保持宽松（`gpt-6-astra-free` 这类写法照旧解析）——那是"查资料"，
  不是"改配置"，两处语义不同

## 修复

- **`protocols` 识别不了 `npm: "@ai-sdk/openai"`**（此前显示「协议不确定」）：现在它是**接口格式声明**
  （协议列显示 `openai`，不标「推断」），比对按 **OpenAI 家族**（chat_completions / responses）——
  模型支持其中任一即 `✓ 匹配`；只有 baseURL 路径含 `/responses` 时才细化为 responses
  （该细化是 URL 启发式，与官方不一致只提示「协议不确定」）。
- **`stepfun/step-5-preview` 这类中转写法报「未收录」**：厂商前缀识别改为
  「静态别名表 + **目录内 vendor 自动并入**」，新增厂商无需改代码；短缩写（如 `step5`）
  新增「前缀匹配」建议（只建议，不自动纠错）。

## 改进

- **模型库与手写配置分流**：`protocols` 默认扫描到的 `pi models-store.json`（工具自动生成的模型清单）
  折叠成一行汇总，其中的「目录未收录」不计入配置问题；`--json` 单列 `store_models` / `store_unmapped`。

## 质量

- 单测 77 → **90 例**：新增配置识别严格模式、模型库分流、`@ai-sdk/openai` 家族判定、
  vendor/id 归一化等用例。
- 对拍：emit **2616 组**零差异；match 弱断言 987 组（新增 `vendor/<id>` 形态护栏）。

## 安装

```bash
npm install -g --install-links=true "github:xlong-c/apifix#v0.2.1"
apifix gpt-6-astra
```

或克隆源码直接 `node apifix.mjs <id>`（零依赖，无需 npm install）。
