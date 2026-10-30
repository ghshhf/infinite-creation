import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeVideos } from '../lib/core/ffmpeg.js';
import {
  resolveUpscale, targetSize, inlineScaleFilter, realesrganCandidates,
  detectRealesrgan, upscaleInputs, UPSCALE_BACKENDS,
} from '../lib/core/video-upscale.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// —— 纯函数：配置归一化 ——

test('resolveUpscale：默认关闭，且给出安全默认值', () => {
  const c = resolveUpscale({});
  assert.equal(c.enabled, false, '默认必须关闭：开启会让导出慢一个数量级，不能靠升级改变老用户行为');
  assert.equal(c.backend, 'auto');
  assert.equal(c.scale, 2);
  assert.equal(c.model, 'realesr-animevideov3');
});

test('resolveUpscale：脏值一律退回安全默认，不抛错', () => {
  const c = resolveUpscale({ generation: { upscale: { backend: '不存在的后端', scale: 999, sharpen: -10, denoise: 'x' } } });
  assert.ok(UPSCALE_BACKENDS.includes(c.backend), '非法 backend 应被替换');
  assert.equal(c.backend, 'auto');
  assert.equal(c.scale, 4, '倍率夹到上限 4');
  assert.equal(c.sharpen, 0, '负锐化夹到 0');
  assert.equal(c.denoise, 0);
});

test('resolveUpscale：非对象配置（null / 字符串 / 数组）不炸', () => {
  for (const bad of [null, 'on', 5, [], true]) {
    const c = resolveUpscale({ generation: { upscale: bad } });
    assert.equal(c.enabled, false, String(bad) + ' 应退回默认');
    assert.equal(c.scale, 2);
  }
});

test('resolveUpscale：enabled 但 backend=off 视为关闭', () => {
  assert.equal(resolveUpscale({ generation: { upscale: { enabled: true, backend: 'off' } } }).enabled, false);
  assert.equal(resolveUpscale({ generation: { upscale: { enabled: true, backend: 'ffmpeg' } } }).enabled, true);
});

test('targetSize：宽高各自乘倍率并保证偶数', () => {
  assert.deepEqual(targetSize(1280, 720, 2), { width: 2560, height: 1440 });
  // 721*1.5=1081.5→1082（偶），481*1.5=721.5→722（偶）
  assert.deepEqual(targetSize(721, 481, 1.5), { width: 1082, height: 722 });
  assert.deepEqual(targetSize(0, 720, 2), { width: 0, height: 0 }, '缺宽高时不猜');
});

test('inlineScaleFilter：先缩放后锐化，参数为 0 时不出现在链里', () => {
  const f = inlineScaleFilter(1440, 810, { sharpen: 0.8, denoise: 0 });
  assert.match(f, /^scale=1440:810:flags=lanczos/);
  assert.match(f, /unsharp=5:5:0\.8/);
  assert.doesNotMatch(f, /hqdn3d/, '降噪为 0 时不该加滤镜');
  // 顺序很重要：先锐化再放大，会把插值前的锯齿一起放大
  assert.ok(f.indexOf('scale=') < f.indexOf('unsharp='), '缩放必须在锐化之前');
  const g = inlineScaleFilter(100, 100, { sharpen: 0, denoise: 3 });
  assert.doesNotMatch(g, /unsharp/);
  assert.match(g, /hqdn3d=3:3:6:9/);
});

test('realesrganCandidates：配置路径优先，项目目录次之，且都给绝对路径', () => {
  const cfg = { generation: { upscale: { bin: 'tools/esrgan.exe' } } };
  const list = realesrganCandidates(cfg, { cwd: '/proj', which: () => '/usr/bin/x' });
  assert.ok(path.isAbsolute(list[0]), '首个候选必须是绝对路径');
  assert.match(list[0], /tools[\\/]esrgan\.exe$/);
  assert.ok(list.some((p) => /bin[\\/]realesrgan/.test(p)), '应包含项目自带目录');
  assert.ok(list.some((p) => /vendor[\\/]realesrgan/.test(p)));
  assert.ok(list.includes('/usr/bin/x'), '应包含 PATH 查到的结果');
  // 去重
  assert.equal(new Set(list).size, list.length);
});

test('detectRealesrgan：找不到工具时返回 ok=false 而不是抛错', async () => {
  // 隔离到空目录 + 空的 PATH 解析结果，否则项目内自带的 bin/realesrgan 会让探测成功
  const r = await detectRealesrgan(
    { generation: { upscale: { bin: '/definitely/not/here/esrgan.exe' } } },
    { cwd: '/nonexistent-project-root', which: () => '' },
  );
  assert.equal(r.ok, false);
  assert.equal(r.bin, '');
  assert.ok(r.reason.length > 0, '必须给出原因');
});

// —— 集成：真的跑 ffmpeg ——

const hasFfmpeg = (() => {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

function mkVideo(out, { size = '320x240', dur = 1, fps = 24 } = {}) {
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=${fps}:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  return out;
}

function probe(p) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p], { encoding: 'utf8' });
  const [w, h] = out.trim().split(',').map(Number);
  return { w, h };
}

test('mergeVideos：单段开超分时不能走「直接复制」捷径', { skip: !hasFfmpeg ? '无 ffmpeg' : false }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'up-t-'));
  try {
    const a = mkVideo(path.join(tmp, 'a.mp4'));
    const plain = path.join(tmp, 'plain.mp4');
    await mergeVideos([a], plain, {});
    assert.deepEqual(probe(plain), { w: 320, h: 240 }, '不开超分时保持原分辨率');

    // 这是关键回归点：单段 + 无音乐 + 无字幕 的早期返回会 copyFileSync，
    // 超分就会静默失效 —— 画面没变，但用户以为开了。
    const up = path.join(tmp, 'up.mp4');
    await mergeVideos([a], up, { upscale: { scale: 2, sharpen: 0.8, denoise: 0 } });
    assert.deepEqual(probe(up), { w: 640, h: 480 }, '开超分后必须真正放大');
    assert.notEqual(fs.statSync(up).size, fs.statSync(a).size, '不应等于源文件（否则说明只是复制）');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mergeVideos：多段合并且超分，尺寸取最大源再乘倍率', { skip: !hasFfmpeg ? '无 ffmpeg' : false }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'up-t-'));
  try {
    const a = mkVideo(path.join(tmp, 'a.mp4'), { size: '320x240' });
    const b = mkVideo(path.join(tmp, 'b.mp4'), { size: '240x180' });
    const out = path.join(tmp, 'two.mp4');
    const srt = '1\n00:00:00,000 --> 00:00:01,000\n测试字幕\n';
    await mergeVideos([a, b], out, { upscale: { scale: 3, sharpen: 0.5, denoise: 0 }, subtitles: srt });
    // 取最大源 320x240 × 3 = 960x720
    assert.deepEqual(probe(out), { w: 960, h: 720 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('mergeVideos：scale<=1 视为不增强，不触发重编码', { skip: !hasFfmpeg ? '无 ffmpeg' : false }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'up-t-'));
  try {
    const a = mkVideo(path.join(tmp, 'a.mp4'));
    const src = fs.statSync(a);
    const out = path.join(tmp, 'same.mp4');
    await mergeVideos([a], out, { upscale: { scale: 1, sharpen: 0.8, denoise: 0 } });
    assert.equal(fs.statSync(out).size, src.size, '倍率 1 应等价于直接复制');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('upscaleInputs：未启用时原样返回，不做任何处理', async () => {
  const r = await upscaleInputs(['/a.mp4', '/b.mp4'], {});
  assert.equal(r.backend, 'off');
  assert.deepEqual(r.paths, ['/a.mp4', '/b.mp4']);
  assert.equal(r.dir, '');
});

test('upscaleInputs：AI 侧失败时退回 ffmpeg 后端而不是抛错', async () => {
  // 两种降级都要覆盖：工具不可用、工具可用但处理失败（这里给一个不存在的输入）。
  // 无论哪种，导出都不能挂——超分是导出链路的最后一环，失败必须降级而不是中断。
  const r = await upscaleInputs(['/a.mp4'], { generation: { upscale: { enabled: true, backend: 'realesrgan', bin: '/nope/esrgan.exe' } } });
  assert.equal(r.backend, 'ffmpeg', '必须降级，不能把导出搞挂');
  assert.deepEqual(r.paths, ['/a.mp4'], '降级后应原样返回输入');
  assert.equal(r.dir, '', '降级时不应留下临时目录');
  assert.ok(r.note.length > 0, '必须说明降级原因');
  assert.match(r.note, /内联|不可用|未找到/);
});

test('upscaleInputs：显式 ffmpeg 后端不探测 AI，直接返回原路径', async () => {
  const r = await upscaleInputs(['/a.mp4'], { generation: { upscale: { enabled: true, backend: 'ffmpeg' } } });
  assert.equal(r.backend, 'ffmpeg');
  assert.deepEqual(r.paths, ['/a.mp4']);
  assert.equal(r.note, '');
});
