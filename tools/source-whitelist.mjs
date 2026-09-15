// source-whitelist.mjs — 官方来源白名单（validate / merge 共用，零依赖 / ESM）
//
// 规则：sources 只接受**第一方厂商域名**（host 等于后缀或为其子域）。
// 通用托管平台（github.com）用 PATH_RULES 限定；云平台文档（AWS/Azure）对非云厂商
// 模型不算官方来源。详见 CONTRIBUTING.md「来源白名单」。

export const OFFICIAL_DOMAINS = {
  openai: ["openai.com"],
  anthropic: ["claude.com", "anthropic.com"],
  google: ["google.dev", "google.com", "googleapis.com"],
  deepseek: ["deepseek.com"],
  alibaba: ["aliyun.com", "alibabacloud.com", "aliyuncs.com", "qwencloud.com", "qianwenai.com"],
  zhipu: ["z.ai", "bigmodel.cn"],
  moonshot: ["kimi.ai", "kimi.com", "moonshot.cn", "moonshot.ai"],
  baidu: ["baidu.com"],
  xai: ["x.ai"],
  meta: ["meta.ai", "meta.com"],
  mistral: ["mistral.ai"],
  cohere: ["cohere.com"],
  tencent: ["tencent.com", "tencent.cn", "tencentcloud.com"],
  volcengine: ["volcengine.com", "bytedance.com", "seed.bytedance.com"],
  nvidia: ["nvidia.com"],
  microsoft: ["microsoft.com", "azure.com"],
  amazon: ["aws.amazon.com", "amazon.com"],
  minimax: ["minimax.io", "minimaxi.com", "minimax.cn"],
  iflytek: ["xfyun.cn", "xf-yun.com"],
  "01ai": ["lingyiwanwu.com"],
  ai21: ["ai21.com"],
  writer: ["writer.com"],
};

// 通用托管平台：host 命中还不够，路径前缀也必须命中（vendor 必须匹配）。
export const SOURCE_PATH_RULES = [
  { vendor: "alibaba", host: "github.com", pathPrefix: "/QwenLM/" },
];

// 拆出 host（去 www.）与 path；非法 URL 返回 null。
export function sourceHost(url) {
  try {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith("www.")) host = host.slice(4);
    return { host, path: parsed.pathname };
  } catch {
    return null;
  }
}

// 该 URL 是否为 vendor 的官方来源？
export function isOfficialSource(url, vendor) {
  const parsed = sourceHost(url);
  if (!parsed) return false;
  const { host, path } = parsed;

  for (const rule of SOURCE_PATH_RULES) {
    if (rule.vendor !== vendor) continue;
    if (host === rule.host || host.endsWith(`.${rule.host}`)) {
      if (path.startsWith(rule.pathPrefix)) return true;
    }
  }

  const suffixes = OFFICIAL_DOMAINS[vendor] || [];
  for (const suffix of suffixes) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

// 过滤出官方来源；返回 {kept, dropped}。
export function filterOfficialSources(sources, vendor) {
  const kept = [];
  const dropped = [];
  for (const src of sources || []) {
    if (typeof src !== "string" || !src) continue;
    if (isOfficialSource(src, vendor)) kept.push(src);
    else dropped.push(src);
  }
  return { kept, dropped };
}
