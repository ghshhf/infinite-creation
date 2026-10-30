#!/usr/bin/env node
// 下载视频超分工具（Real-ESRGAN ncnn-vulkan）到 bin/realesrgan/。
//
// 为什么单独下载、不进仓库：可执行文件 + 模型有几十 MB，二进制入库会让 clone
// 变慢且无法跨平台复用（Windows/macOS/Linux 各一套）。仓库只保留这份脚本。
//
// 用法：
//   node scripts/fetch-upscale-tool.mjs
//   node scripts/fetch-upscale-tool.mjs --url <自定义下载地址>    # 国内镜像
//   node scripts/fetch-upscale-tool.mjs --force                 # 已存在也重下
//
// 只保留视频超分实际用到的 realesr-animevideov3（x2/x3/x4 各约 1.2MB），
// 其余模型（x4plus 33MB、x4plus-anime 9MB）会被删掉，落到 bin/ 里约 10MB。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'bin', 'realesrgan');

const PLATFORM_PACKAGES = {
  win32: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',
    bin: 'realesrgan-ncnn-vulkan.exe',
  },
  darwin: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-macos.zip',
    bin: 'realesrgan-ncnn-vulkan',
  },
  linux: {
    url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-ubuntu.zip',
    bin: 'realesrgan-ncnn-vulkan',
  },
};

// 超分只需要这个模型族；其余按体积丢弃
const KEEP_MODEL_PREFIX = 'realesr-animevideov3';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function download(url, timeoutMs = 30 * 60 * 1000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败 ' + res.status + '：' + url);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  let lastPrint = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    got += chunk.length;
    const now = Date.now();
    if (now - lastPrint > 1000) {
      lastPrint = now;
      const pct = total ? Math.round((got / total) * 100) : 0;
      process.stdout.write('\r  下载中 ' + (got / 1048576).toFixed(1) + 'MB' + (total ? ' / ' + (total / 1048576).toFixed(0) + 'MB（' + pct + '%）' : ''));
    }
  }
  process.stdout.write('\n');
  return Buffer.concat(chunks);
}

async function main() {
  const pkg = PLATFORM_PACKAGES[process.platform];
  if (!pkg) throw new Error('暂不支持该平台：' + process.platform + '（请手动下载 Real-ESRGAN 并放到 bin/realesrgan/）');

  const exePath = path.join(DEST, pkg.bin);
  const force = process.argv.includes('--force');
  if (!force && fs.existsSync(exePath) && fs.existsSync(path.join(DEST, 'models'))) {
    console.log('已存在：' + path.relative(ROOT, exePath));
    console.log('（要重新下载加 --force）');
    return;
  }

  const url = arg('--url', pkg.url);
  console.log('下载 Real-ESRGAN：' + url);
  console.log('提示：GitHub 直连很慢时，可用 --url 换成镜像地址，或先设好系统代理。');
  let buf;
  try {
    buf = await download(url);
  } catch (e) {
    throw new Error('下载失败：' + e.message + '\n可手动下载后解压到 ' + path.relative(ROOT, DEST) + '：\n  ' + pkg.url);
  }

  console.log('解压到 ' + path.relative(ROOT, DEST));
  fs.mkdirSync(DEST, { recursive: true });
  const zip = new AdmZip(buf);
  // 压缩包是平铺结构（exe/dll/models 都在根），直接解到目标目录
  zip.extractAllTo(DEST, true);

  // 清掉用不到的大模型，只留视频超分要用的那一族
  const modelsDir = path.join(DEST, 'models');
  if (fs.existsSync(modelsDir)) {
    let freed = 0;
    for (const f of fs.readdirSync(modelsDir)) {
      if (f.startsWith(KEEP_MODEL_PREFIX)) continue;
      if (!/\.(bin|param)$/i.test(f)) continue;
      freed += fs.statSync(path.join(modelsDir, f)).size;
      fs.rmSync(path.join(modelsDir, f), { force: true });
    }
    if (freed) console.log('已清理未用模型，释放 ' + (freed / 1048576).toFixed(1) + 'MB');
  }

  if (process.platform !== 'win32') {
    try { fs.chmodSync(exePath, 0o755); } catch {}
  }

  const finalSize = (() => {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else n += fs.statSync(p).size;
      }
    };
    walk(DEST);
    return n;
  })();

  console.log('\n完成：' + path.relative(ROOT, exePath) + '（合计 ' + (finalSize / 1048576).toFixed(1) + 'MB）');
  console.log('在 config.json 里开启：generation.upscale.enabled = true');
}

main().catch((e) => {
  console.error('错误：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
