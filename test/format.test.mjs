// format 单测 —— 锁住 core 导出的共享格式化实现（displayWidth / pad / groupThousands）。
// 这些函数被 CLI（--list/--match 表格、--card 盒线）与 core 内部（fmtNum 等）共用，
// CLI 输出字节依赖它们（不变量 3），行为回归时这里应当先红。
// 断言值全部取自当前实现的真实输出（先跑一遍确认再固化），不做"期望应该怎样"的臆断。
import test from "node:test";
import assert from "node:assert/strict";

import { displayWidth, pad, groupThousands } from "../lib/core.mjs";

// ------------------------------------------------------------- displayWidth

test("displayWidth：ASCII 每字符计 1", () => {
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth("a b-c1"), 6);
});

test("displayWidth：CJK 全角字符计 2（WIDE 表 0x4e00-0x9fff）", () => {
  assert.equal(displayWidth("上下"), 4);
  assert.equal(displayWidth("a上b"), 4); // 1 + 2 + 1
  assert.equal(displayWidth("模型"), 4);
});

test("displayWidth：emoji 落在 WIDE 表区间（0x1F300-0x1F64F）计 2", () => {
  // U+1F600 在 [0x1F300, 0x1F64F] 内，按表计 2（不做 Unicode 语义宽窄判断）
  assert.equal(displayWidth("\u{1F600}"), 2);
});

test("displayWidth：组合字符不额外计宽（Mn 跳过）", () => {
  // "e" + U+0301 组合尖音符：整体计 1（组合符号本身不计）
  assert.equal(displayWidth("e\u0301"), 1);
});

test("displayWidth：非字符串输入先转 String", () => {
  assert.equal(displayWidth(123), 3);
  assert.equal(displayWidth(null), 4); // String(null) = "null"
});

// --------------------------------------------------------------------- pad

test("pad：默认左对齐，不足补尾随空格", () => {
  assert.equal(pad("ab", 5), "ab   ");
  assert.equal(pad("abcde", 5), "abcde"); // 恰好等宽：无填充
});

test("pad：超宽不截断，原样返回（列可能被顶开，历史行为）", () => {
  assert.equal(pad("abcdef", 5), "abcdef");
});

test("pad：宽度按 displayWidth（CJK 计 2）而非字符数", () => {
  // "上" 显示宽度 2，再补 3 个空格凑到 5
  assert.equal(pad("上", 5), "上   ");
});

test("pad：right / center 对齐", () => {
  assert.equal(pad("ab", 5, "right"), "   ab");
  assert.equal(pad("ab", 5, "center"), " ab  ");
  // 奇数空隙：左侧 floor(gap/2)，右侧拿余量
  assert.equal(pad("a", 6, "center"), "  a   ");
});

// ------------------------------------------------------------ groupThousands

test("groupThousands：千分位分组", () => {
  assert.equal(groupThousands(1234567), "1,234,567");
  assert.equal(groupThousands(1000), "1,000");
  assert.equal(groupThousands(123), "123"); // 不足四位不分组
  assert.equal(groupThousands(0), "0");
});

test("groupThousands：负数分组（负号不在分组内）", () => {
  assert.equal(groupThousands(-1234567), "-1,234,567");
});

test("groupThousands：按字符串字面量分组（实现不校验数值）", () => {
  // 实现是纯 String + 正则，不区分输入类型；小数点前后都按 \B(?=(\d{3})+) 规则处理
  assert.equal(groupThousands("1234567"), "1,234,567");
  assert.equal(groupThousands("123456.789"), "123,456.789");
});
