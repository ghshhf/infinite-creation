import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { runCapture as defaultRunCapture } from './ffmpeg.js';

// 画质增强（超分）。
//
// 两条路线，取舍不同，所以都留：
//
//  · ffmpeg（内联）：在合片的 filter_complex 里顺带放大 + 锐化。
//    不额外解码一轮、不额外编码一轮，代价几乎为零，任何机器开箱可用。
//    但它只是高质量插值，不能凭空造出细节 —— 源就模糊的话，放大后还是模糊。
//
//  · realesrgan（逐帧 AI）：拆帧 → Real-ESRGAN 逐帧推理 → 合帧。
//    会二次编码，速度按帧算（1660Ti 上 720p 约 0.2-0.5s/帧），但能补真实纹理。
//    需要外部可执行文件，缺失时自动退回 ffmpeg 而不是让导出失败。
//
// 默认 auto：探测到 realesrgan 就用它，否则用 ffmpeg。导出是长链路的最后一步，
// 「因为超分工具没装就整片导不出来」是不可接受的失败模式。

export const UPSCALE_BACKENDS = ['off', 'auto', 'ffmpeg', 'realesrgan'];
// Real-ESRGAN 模型：animevideov3 是轻量视频向（支持 2/3/4 倍），x4plus 是通用 4 倍（重、慢、细节更强）
export const UPSCALE_MODELS = ['realesr-animevideov3', 'realesrgan-x4plus', 'realesrgan-x4plus-anime'];

const DEFAULT_BIN = 'realesrgan-ncnn-vulkan';

// 归一化配置。任何脏值都退回安全默认，绝不因为一个配置字段写错就让导出抛错。
export function resolveUpscale(cfg) {
  const raw = cfg?.generation?.upscale;
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const backend = UPSCALE_BACKENDS.includes(String(src.backend || '').toLowerCase())
    ? String(src.backend).toLowerCase()
    : 'auto';
  const model = UPSCALE_MODELS.includes(String(src.model || ''))
    ? String(src.model)
    : 'realesr-animevideov3';
  // 倍率：ffmpeg 后端支持 1.5 这类小数，AI 后端只认整数（模型限制）。统一夹到 1~4。
  const scale = Math.min(4, Math.max(1, Number(src.scale) || 2));
  return {
    enabled: src.enabled === true && backend !== 'off',
    backend,
    scale,
    model,
    // 锐化强度（unsharp luma amount）。0 = 不锐化。放大后适度锐化能压掉插值带来的软边。
    sharpen: Math.min(3, Math.max(0, src.sharpen == null ? 0.8 : Number(src.sharpen) || 0)),
    // 降噪强度（hqdn3d）。AI 生成的画面本身较干净，默认关；实拍素材放大前需要。
    denoise: Math.min(10, Math.max(0, Number(src.denoise) || 0)),
    // AI 后端的产物画质（x264 crf）。二次编码必然有损，18 是肉眼几乎无损的常用值。
    crf: Math.min(30, Math.max(12, Number(src.crf) || 18)),
    bin: String(src.bin || '').trim() || DEFAULT_BIN,
    extraArgs: Array.isArray(src.extraArgs) ? src.extraArgs.map(String) : [],
    // 逐帧超分的帧数上限：防止误开在长片上吃满磁盘（一帧 720p PNG 约 1MB）
    maxFrames: Math.max(24, Number(src.maxFrames) || 3600),
  };
}

function even(n) {
  const v = Math.round(Number(n) || 0);
  return v % 2 ? v + 1 : v;
}

// 目标尺寸：宽高各自乘倍率并保证偶数（h264 要求）。宽高缺失时返回 0，由调用方跳过。
export function targetSize(width, height, scale) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  if (!w || !h) return { width: 0, height: 0 };
  return { width: even(w * scale), height: even(h * scale) };
}

// 内联滤镜：负责把「已经是目标尺寸」的输入，用高质量算法缩放 + 锐化。
// 注意顺序是「先放大再锐化」——反过来会把插值前的锯齿一起放大。
export function inlineScaleFilter(width, height, { sharpen = 0, denoise = 0 } = {}) {
  const w = even(width);
  const h = even(height);
  let f = 'scale=' + w + ':' + h + ':flags=lanczos';
  if (denoise > 0) f += ',hqdn3d=' + denoise + ':' + denoise + ':' + (denoise * 2) + ':' + (denoise * 3);
  if (sharpen > 0) f += ',unsharp=5:5:' + sharpen + ':5:5:0';
  return f;
}

// —— 外部 AI 后端 ——

function runBin(bin, args, { timeoutMs = 10 * 60 * 1000, isAborted, onLog, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      // cwd 必须落在可执行文件目录：ncnn-vulkan 的 -m 默认是相对路径 "models"，
      // 换个工作目录启动就会「找不到模型」直接退出，而这个报错很难联想到 cwd。
      p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    } catch (e) {
      reject(new Error(bin + ' 启动失败：' + e.message));
      return;
    }
    let output = '';
    let settled = false;
    let aborter;
    const killer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      if (!settled) { settled = true; clearInterval(aborter); reject(new Error(bin + ' 执行超时（' + Math.round(timeoutMs / 1000) + 's）')); }
    }, timeoutMs);
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      clearInterval(aborter);
      fn(v);
    };
    if (isAborted) {
      aborter = setInterval(() => {
        if (!isAborted()) return;
        try { p.kill('SIGKILL'); } catch {}
        done(reject, new Error('已停止：' + bin + ' 已被终止'));
      }, 800);
    }
    // stdout 与 stderr 合并收集：ncnn-vulkan 把帮助信息打到 stdout、进度打到 stderr，
    // 只收 stderr 会让「能运行」的探测拿不到任何判据。
    p.stderr.on('data', (d) => { const s = d.toString(); output += s; if (onLog) onLog(s); });
    p.stdout.on('data', (d) => { const s = d.toString(); output += s; if (onLog) onLog(s); });
    p.on('error', (e) => done(reject, new Error(bin + ' 启动失败：' + e.message)));
    p.on('close', (code) => {
      if (code === 0) done(resolve);
      else {
        // 头尾都留：真正的报错常在结尾，而「Usage / 帮助信息」这类可用性证据总在开头，
        // 只截尾会把证据截没，导致能跑的工具被判成不可用。
        const brief = output.length > 800 ? output.slice(0, 300) + ' … ' + output.slice(-400) : output;
        done(reject, new Error(bin + (code === null ? ' 被强制终止' : ' 退出码 ' + code) + (brief ? '：' + brief : '')));
      }
    });
  });
}

// 在 PATH 里解析可执行文件的绝对路径。返回空串表示找不到。
function whichSync(name) {
  try {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(bin, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
    return String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  } catch {
    return '';
  }
}

// 候选可执行文件路径（纯函数，便于单测）。
// 顺序：显式配置 → 项目自带 → PATH。一律给绝对路径，后续启动要把 cwd 设到它所在目录。
export function realesrganCandidates(cfg, { cwd = process.cwd(), which = whichSync } = {}) {
  const conf = resolveUpscale(cfg);
  const root = path.resolve(cwd);
  const list = [];
  const push = (p) => { if (p && !list.includes(p)) list.push(p); };
  if (conf.bin && conf.bin !== DEFAULT_BIN) {
    // 配置项可能是绝对路径、相对项目根的路径、或裸名字
    push(path.isAbsolute(conf.bin) ? conf.bin : path.resolve(root, conf.bin));
  }
  // 项目内自带目录：支持「下载解压即用」，不必改 PATH
  for (const dir of ['bin/realesrgan', 'vendor/realesrgan']) {
    for (const name of [DEFAULT_BIN, DEFAULT_BIN + '.exe']) push(path.join(root, dir, name));
  }
  push(which(DEFAULT_BIN));
  if (process.platform === 'win32') push(which(DEFAULT_BIN + '.exe'));
  return list;
}

// 探测 AI 后端是否可用。
// opts 可注入 cwd / which，便于测试在「没有装工具」的假设下隔离验证。
// 返回 { ok, bin, dir, reason }，不抛错 —— 探测失败是正常分支，不是异常。
export async function detectRealesrgan(cfg, opts = {}) {
  for (const bin of realesrganCandidates(cfg, opts)) {
    let st;
    try { st = fs.statSync(bin); } catch { continue; }
    if (!st.isFile()) continue;
    const dir = path.dirname(bin);
    // 模型目录是 ncnn-vulkan 的必需依赖，缺了直接算不可用，省得跑到一半才失败
    if (!fs.existsSync(path.join(dir, 'models'))) {
      return { ok: false, bin: '', dir: '', reason: bin + ' 所在目录缺少 models/（模型未随包解压完整）' };
    }
    try {
      await runBin(bin, ['-h'], { timeoutMs: 15_000, cwd: dir });
      return { ok: true, bin, dir, reason: '' };
    } catch (e) {
      // ncnn-vulkan 的 -h 在部分版本退出码非 0，但它已经打印了帮助，说明二进制可运行
      if (/Usage:|-i input-path/.test(String(e && e.message || ''))) return { ok: true, bin, dir, reason: '' };
    }
  }
  return { ok: false, bin: '', dir: '', reason: '未找到 ' + DEFAULT_BIN + '（可用 generation.upscale.bin 指定路径）' };
}

async function probeSize(runCapture, inputPath) {
  const out = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames', '-of', 'json', inputPath], { timeoutMs: 20_000, captureStdout: true });
  try {
    const s = (JSON.parse(out).streams || [])[0] || {};
    const [num, den] = String(s.avg_frame_rate || '0/1').split('/').map(Number);
    return {
      width: Number(s.width) || 0,
      height: Number(s.height) || 0,
      fps: den ? num / den : 24,
      frames: Number(s.nb_frames) || 0,
    };
  } catch {
    throw new Error('ffprobe 解析失败：' + inputPath);
  }
}

function countFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).length;
  } catch {
    return 0;
  }
}

// ncnn-vulkan 每帧都往 stderr 打一行百分比，逐行转发会把日志刷成一片数字。
// 只保留有信息量的行（错误、耗时、显存提示）。
function meaningfulLog(s) {
  const t = String(s || '').replace(/[\r\n]+/g, ' ').trim();
  if (!t) return '';
  if (/^\d+(\.\d+)?%$/.test(t)) return '';
  return t;
}

// 逐帧 AI 超分。返回 { output, frames, skipped }。
// skipped 表示因帧数上限被降级（调用方据此决定是否退回内联方案）。
export async function upscaleVideoAi(inputPath, outputPath, conf, { runCapture, isAborted, onLog } = {}) {
  const log = (s) => { const t = meaningfulLog(s); if (t && onLog) onLog(t); };
  const info = await probeSize(runCapture, inputPath);
  if (!info.width || !info.height) throw new Error('无法探测源视频分辨率：' + inputPath);

  // AI 后端的倍率受模型限制（animevideov3 支持 2/3/4；x4plus 固定 4），取整并夹到合法区间
  const scale = Math.round(conf.scale) || 2;
  const est = info.frames || Math.round(info.fps * 10);
  if (est > conf.maxFrames) {
    return { output: '', frames: 0, skipped: '帧数 ' + est + ' 超过上限 ' + conf.maxFrames };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-upscale-'));
  const inDir = path.join(tmp, 'in');
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  try {
    // 拆帧。png 无损；passthrough 保证不因时间戳补帧/丢帧导致帧序错乱。
    // ffmpeg 5.1 起用 -fps_mode 取代 -vsync，而 9.0 已彻底移除 -vsync（报 Unrecognized option）。
    // 两个都写死会在某一代 ffmpeg 上必然失败，所以按能力回退。
    if (onLog) onLog('[超分] 拆帧 ' + path.basename(inputPath) + '\n');
    const extract = (modeArgs) => runCapture('ffmpeg', ['-y', '-v', 'error', '-i', inputPath, '-an', ...modeArgs, path.join(inDir, '%06d.png')], { timeoutMs: 20 * 60 * 1000, isAborted });
    try {
      await extract(['-fps_mode', 'passthrough']);
    } catch (e) {
      if (isAborted && isAborted()) throw e;
      if (!/Unrecognized option|Option not found|fps_mode/i.test(String(e && e.message || ''))) throw e;
      await extract(['-vsync', '0']);
    }
    const n = countFiles(inDir);
    if (!n) throw new Error('拆帧失败，未产出任何帧');
    if (n > conf.maxFrames) throw new Error('帧数 ' + n + ' 超过上限 ' + conf.maxFrames);

    // 逐帧推理。-f png 强制输出格式；-j 控制并发（ncnn 内部是多线程 Vulkan，并发过高反而抢显存）
    if (onLog) onLog('[超分] AI 推理 ' + n + ' 帧（' + conf.model + ' x' + scale + '）\n');
    const args = ['-i', inDir, '-o', outDir, '-n', conf.model, '-s', String(scale), '-f', 'png', '-j', '2:2:2', ...conf.extraArgs];
    await runBin(conf.bin, args, { timeoutMs: Math.max(10 * 60 * 1000, n * 8000), isAborted, onLog: log, cwd: conf.cwd });
    const m = countFiles(outDir);
    if (m !== n) throw new Error('AI 超分帧数不匹配：输入 ' + n + '，输出 ' + m);

    // 合帧：视频取超分结果，音轨直接沿用源（不重编码音频，避免无谓损失）
    if (onLog) onLog('[超分] 合帧 → ' + path.basename(outputPath) + '\n');
    await runCapture('ffmpeg', [
      '-y', '-v', 'error',
      '-framerate', String(info.fps),
      '-i', path.join(outDir, '%06d.png'),
      '-i', inputPath,
      '-map', '0:v:0', '-map', '1:a?',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', String(conf.crf),
      '-pix_fmt', 'yuv420p', '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], { timeoutMs: 60 * 60 * 1000, isAborted });
    return { output: outputPath, frames: n, skipped: '' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

// 导出用批量超分：对每个分镜单独做 AI 超分，产出到临时目录。
//
// 为什么在「分镜」而不是「成片」上做：一次导出会产出两份成片（带字幕 / 不带字幕），
// 在成片上做就得跑两遍，白烧一倍时间。放在分镜上只跑一遍总量，两份成片共用结果。
//
// 返回 { backend, paths, dir, note }：
//  · backend='realesrgan' → paths 是超分后的临时文件，调用方合片时不要再加内联放大；
//  · backend='ffmpeg'     → paths 是原输入，调用方用内联滤镜（mergeVideos 的 upscale 参数）；
//  · 失败一律退回 'ffmpeg' 并带 note，不让「超分工具没装好」把整片导出搞挂。
export async function upscaleInputs(inputPaths, cfg, { runCapture = defaultRunCapture, isAborted, onLog, tmpParent } = {}) {
  const conf = resolveUpscale(cfg);
  if (!conf.enabled) return { backend: 'off', paths: inputPaths, dir: '', note: '超分未启用' };
  if (conf.backend === 'ffmpeg') return { backend: 'ffmpeg', paths: inputPaths, dir: '', note: '' };

  const det = await detectRealesrgan(cfg);
  if (!det.ok) return { backend: 'ffmpeg', paths: inputPaths, dir: '', note: 'AI 超分不可用，已改用内联滤镜：' + det.reason };

  // 临时目录默认跟随系统，但调用方应传入「与项目同盘」的目录：
  // 超分产物是整段视频（几十到几百 MB），放在系统盘会把空间紧张的机器直接撑爆。
  const dir = fs.mkdtempSync(path.join(tmpParent || os.tmpdir(), 'ic-up-'));
  const paths = [];
  try {
    for (let i = 0; i < inputPaths.length; i++) {
      const out = path.join(dir, 'up' + String(i + 1).padStart(4, '0') + '.mp4');
      if (onLog) onLog('[超分] 第 ' + (i + 1) + '/' + inputPaths.length + ' 段：' + path.basename(inputPaths[i]) + '\n');
      await upscaleVideoAi(inputPaths[i], out, { ...conf, bin: det.bin, cwd: det.dir }, { runCapture, isAborted, onLog });
      paths.push(out);
    }
    return { backend: 'realesrgan', paths, dir, note: '' };
  } catch (e) {
    // 中途失败不能只超分一半再拼：同一片里一半清晰一半原样，看起来像画面在跳。
    // 整体作废，退回内联滤镜重来。
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (isAborted && isAborted()) throw e;
    return { backend: 'ffmpeg', paths: inputPaths, dir: '', note: 'AI 超分失败，已改用内联滤镜：' + (e && e.message ? e.message : String(e)) };
  }
}

// 返回实际使用的后端与产物路径，便于上报给用户（不能静默降级）。
export async function upscaleVideo(inputPath, outputPath, cfg, { runCapture, isAborted, onLog } = {}) {
  const conf = resolveUpscale(cfg);
  if (!conf.enabled) return { backend: 'off', output: inputPath, frames: 0, note: '超分未启用' };
  if (conf.backend === 'realesrgan') {
    const det = await detectRealesrgan(cfg);
    if (!det.ok) throw new Error('已配置 AI 超分但工具不可用：' + det.reason);
    const r = await upscaleVideoAi(inputPath, outputPath, { ...conf, bin: det.bin, cwd: det.dir }, { runCapture, isAborted, onLog });
    return { backend: 'realesrgan', ...r };
  }
  // ffmpeg 后端：单独跑一遍滤镜（成片级场景不经过 mergeVideos 时用）
  const info = await probeSize(runCapture, inputPath);
  const t = targetSize(info.width, info.height, conf.scale);
  await runCapture('ffmpeg', [
    '-y', '-v', 'error', '-i', inputPath,
    '-vf', inlineScaleFilter(t.width, t.height, conf),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(conf.crf),
    '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart',
    outputPath,
  ], { timeoutMs: 60 * 60 * 1000, isAborted });
  return { backend: 'ffmpeg', output: outputPath, frames: 0, note: '' };
}
