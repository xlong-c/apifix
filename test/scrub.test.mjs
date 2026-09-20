// 脱敏函数测试 —— scrub（文本兜底脱敏）与 stripCredentials（凭证键剥离）
// 凭证纪律：夹具只用假值（sk-TEST、sk-proj-TEST、Bearer TEST 等），绝不使用真实 key。
import test from "node:test";
import assert from "node:assert/strict";

import { scrub, stripCredentials, isCredentialKey } from "../lib/core.mjs";

test("sk- 前缀密钥整串脱敏", () => {
  assert.equal(scrub("key is sk-TEST1234567890 done"), "key is [REDACTED] done");
  // OpenRouter 具名前缀
  assert.equal(scrub("sk-or-v1-abcdefgh1234"), "[REDACTED]");
});

test("Bearer 值脱敏：保留 Bearer 字样，只脱值", () => {
  assert.equal(scrub("Authorization: Bearer TESTTOKEN1234567890"), "Authorization: Bearer [REDACTED]");
  // 大小写变体（规则为 /i）
  assert.equal(scrub("bearer tttttttt1234567890"), "Bearer [REDACTED]");
});

test("key=value 规则：保留键名与分隔符，只脱 16+ 字符值", () => {
  assert.equal(scrub("apiKey=abcdefgh12345678"), "apiKey=[REDACTED]");
  // 引号包裹：保留引号
  assert.equal(scrub('My_Secret_Key: "abcdefgh1234567890"'), 'My_Secret_Key: "[REDACTED]"');
  // 短值（<16 字符）不脱
  assert.equal(scrub("apiKey=short"), "apiKey=short");
});

test("同一行多凭证：每处都脱敏", () => {
  assert.equal(
    scrub("APIKEY:abcdefgh12345678 ApiToken=qrstuvwxyz123456"),
    "APIKEY:[REDACTED] ApiToken=[REDACTED]",
  );
  assert.equal(
    scrub("openai_key = abcdefgh12345678;X-Api-Token: abcdefghijklmnopq"),
    "openai_key = [REDACTED];X-Api-Token: [REDACTED]",
  );
});

test("大小写变体的键名：APIKEY / ApiToken / password 均被识别", () => {
  assert.equal(scrub("APIKEY:abcdefgh12345678"), "APIKEY:[REDACTED]");
  assert.equal(scrub("ApiToken=qrstuvwxyz123456"), "ApiToken=[REDACTED]");
  assert.equal(scrub("password=aaaaaaaaaaaaaaaa1234"), "password=[REDACTED]");
});

test("非凭证键不受影响（宁多脱不漏脱，但 ok= 不在凭证键名表内）", () => {
  assert.equal(scrub("ok=aaaaaaaaaaaaaaaa1234"), "ok=aaaaaaaaaaaaaaaa1234");
});

test("嵌套对象被 String() 后仍可脱敏（scrub 接受任意输入并转字符串）", () => {
  const out = scrub({ nested: { apiKey: "sk-TEST1234567890" } });
  assert.equal(typeof out, "string");
  assert.ok(!out.includes("sk-TEST1234567890"), "原值不得出现在输出中");
});

test("allow 白名单：公开 id 独立出现时受保护，凭证照常脱敏", () => {
  const text = "use ark-code-latest and ark-1234567890abcdef";
  assert.equal(scrub(text, ["ark-code-latest"]), "use ark-code-latest and [REDACTED]");
  // 不给白名单时：公开 id 也会撞上 ark- 规则被脱敏
  assert.equal(scrub(text), "use [REDACTED] and [REDACTED]");
  // 白名单串嵌入更大 token（前后仍是 token 字符）时不保护，照常脱敏
  assert.equal(scrub("prefix-ark-code-latest-suffix", ["ark-code-latest"]), "prefix-[REDACTED]");
});

test("isCredentialKey：键名形态判断", () => {
  assert.equal(isCredentialKey("apiKey"), true);
  assert.equal(isCredentialKey("api_key"), true);
  assert.equal(isCredentialKey("AUTH_TOKEN"), true);
  assert.equal(isCredentialKey("experimental_bearer_token"), true);
  assert.equal(isCredentialKey("temperature"), false);
  assert.equal(isCredentialKey("context_window"), false);
});

test("stripCredentials：深拷贝并剥离凭证键，其余结构原样", () => {
  const input = {
    api_key: "sk-TEST-not-a-real-key",
    keep: 1,
    sub: {
      token: "x".repeat(20),
      list: [{ secretKey: "y".repeat(16), name: "ok" }],
    },
  };
  const out = stripCredentials(input);
  assert.deepEqual(out, { keep: 1, sub: { list: [{ name: "ok" }] } });
  // 不修改入参（纯函数）
  assert.equal(input.api_key, "sk-TEST-not-a-real-key");
  assert.equal(input.sub.token, "x".repeat(20));
});

test("stripCredentials：数组保持数组形状", () => {
  const out = stripCredentials([{ apiKey: "sk-TEST1234567890", n: 2 }, 3, "plain"]);
  assert.deepEqual(out, [{ n: 2 }, 3, "plain"]);
});

test("NUMERIC_SPEC_FIELD_KEYS 白名单：maxOutputTokens 等规格数值键不误删", () => {
  const out = stripCredentials({ maxOutputTokens: 4096, max_output_tokens: 4096 });
  assert.deepEqual(out, { maxOutputTokens: 4096, max_output_tokens: 4096 });
});
