# Release v0.2.2

> `apifix fix` 的计划与摘要**逐条点名**：谁未收录、谁被修正，一目了然。

## 修复

此前 `apifix fix` 只报总数（如 `共 7 个模型：1 未收录`），看不到具体是哪个模型。
现在：

- **计划正文逐条列出未收录条目**：`[?] <id> → 未收录`，并给出「最接近」候选
  （归一化写法会标注「未自动采用官网规格」）；可修的模型标注 `（待修 N 项）`
- **应用后逐条列出被改动的模型与字段**（字段用中文标签）：

  ```
  已修复 1 项 / 1 个模型：
    - glm-5.3-flash（上下文）
  ```

- 计划末尾对未收录条目给出明确提示：**不参与修正**——确认型号后改用官网 id，
  或在 catalog 里登记 alias 锚定

## 质量

- 单测 90 → **91 例**（新增修复计划点名用例）。
- 对拍 2616 组 emit 零差异、match 弱断言 987 组；CI 双平台绿。

## 安装

```bash
npm install -g --install-links=true "github:xlong-c/apifix#v0.2.2"
apifix fix opencode --dry-run
```

或克隆源码直接 `node apifix.mjs <id>`（零依赖，无需 npm install）。
