// UI 本地服务的模型嗅探接口 (/api/models, /api/sniff) 端到端测试
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, "apifix.mjs");

test("UI 服务端模型嗅探接口 (/api/models & /api/sniff)", async (t) => {
  // 1. 建立模拟上游供应商服务，直接 listen(0) 自动分配可用端口
  let mockPort = 0;
  const mockServer = createServer((req, res) => {
    const urlObj = new URL(req.url, `http://127.0.0.1:${mockPort}`);
    if (urlObj.pathname === "/v1/models" || urlObj.pathname === "/models") {
      const auth = req.headers.authorization || "";
      if (auth.includes("bad-key")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "deepseek-chat", object: "model" },
          { id: "custom-relay-model", object: "model" },
        ],
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => {
      mockPort = mockServer.address().port;
      resolve();
    });
  });
  t.after(() => mockServer.close());

  // 2. 启动 apifix --ui 服务并从 stdout 读取实际监听的 URL
  const uiPort = 18899;
  const uiProc = spawn(process.execPath, [CLI, "--ui", "--port", String(uiPort), "--no-open"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => uiProc.kill("SIGTERM"));

  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("UI server start timeout")), 5000);
    uiProc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      const match = /(http:\/\/127\.0\.0\.1:\d+\/)/.exec(text);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].replace(/\/+$/, ""));
      }
    });
    uiProc.stderr.on("data", (chunk) => {
      // 捕获 stderr 用于调试
    });
    uiProc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    uiProc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`UI server exited prematurely with code ${code}`));
    });
  });

  const mockBaseUrl = `http://127.0.0.1:${mockPort}/v1`;

  // (a) OPTIONS 预检请求测试
  const optRes = await fetch(`${baseUrl}/api/models`, { method: "OPTIONS" });
  assert.equal(optRes.status, 204, "OPTIONS 预检应返回 204");
  assert.equal(optRes.headers.get("access-control-allow-origin"), "*", "应支持 CORS *");

  // (b) 缺少 baseURL 错误测试
  const missingRes = await fetch(`${baseUrl}/api/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseURL: "" }),
  });
  assert.equal(missingRes.status, 400, "缺少 baseURL 应返回 400");
  const missingData = await missingRes.json();
  assert.equal(missingData.ok, false);
  assert.match(missingData.error, /baseURL/);

  // (c) 正常 POST 嗅探
  const sniffRes = await fetch(`${baseUrl}/api/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseURL: mockBaseUrl, apiKey: "sk-valid-key" }),
  });
  assert.equal(sniffRes.status, 200, "合法嗅探应返回 200");
  const sniffData = await sniffRes.json();
  assert.equal(sniffData.ok, true);
  assert.equal(sniffData.count, 3);
  assert.deepEqual(sniffData.models, ["gpt-4o", "deepseek-chat", "custom-relay-model"]);

  // (d) GET 形式嗅探 (/api/sniff)
  const getRes = await fetch(`${baseUrl}/api/sniff?baseURL=${encodeURIComponent(mockBaseUrl)}&apiKey=sk-test`);
  assert.equal(getRes.status, 200, "GET /api/sniff 应支持");
  const getData = await getRes.json();
  assert.equal(getData.ok, true);
  assert.equal(getData.models.length, 3);

  // (e) 401 模拟测试
  const errRes = await fetch(`${baseUrl}/api/models`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseURL: mockBaseUrl, apiKey: "sk-bad-key" }),
  });
  assert.equal(errRes.status, 400, "供应商 401 时应返回 400");
  const errData = await errRes.json();
  assert.equal(errData.ok, false);
  assert.match(errData.error, /HTTP 401/);
});
