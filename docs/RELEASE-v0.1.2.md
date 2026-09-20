# Release v0.1.2

> 安装说明修正（npm 全局安装不再装出残缺包）、CI Windows 矩阵行尾修复、CI actions 升级。

## 修复

### npm 全局安装会装出不完整的包（文档修正）

`npm install -g github:xlong-c/apifix` 在 npm 11 下可能只装出残缺的包，运行时报
`Cannot find module .../apifix.mjs`。原因：npm 的 `install-links` 默认为 `false`，
会把 git 依赖做成 junction 直接指向缓存临时目录，而不是打包安装。

安装命令请带 `--install-links=true`（对其它 npm 版本无副作用），或改用 tarball 安装：

```bash
npm install -g --install-links=true "github:xlong-c/apifix#v0.1.2"   # 锁定版本（推荐）
npm install -g https://github.com/xlong-c/apifix/archive/refs/tags/v0.1.2.tar.gz
```

README / README.en.md 的安装小节已同步更新（含版本锁定示例）。

### CI：windows 矩阵自引入以来一直假红

windows-latest runner 的 Git 默认 `core.autocrlf=true`，检出时把文本文件转成 CRLF；
而 `tools/build-catalog.mjs --check` 是逐字节比较，于是在 Windows 上误报
「catalog.json 与 catalog/ 不一致」（ubuntu 不受影响）。新增 `.gitattributes`
（`* text=auto eol=lf`）统一各平台检出为 LF，逐字节校验继续保持严格。

## 工程化

- CI actions 升级：`actions/checkout` / `actions/setup-node` → v7，消除
  Node.js 20 runtime 弃用告警。
- windows 矩阵此前从未跑到底的 fix / login 冒烟步骤，现已全部通过。

## 说明

本版本无功能变更，仅安装说明与 CI 层面的修复。

## 安装

```bash
npm install -g --install-links=true github:xlong-c/apifix
apifix gpt-6-astra
```

或克隆源码直接 `node apifix.mjs <id>`（零依赖，无需 npm install）。
