import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 子进程超时兜底：ffmpeg/ffprobe 假死（磁盘慢、文件损坏、锁死）时 close 事件永不触发，
// Promise 永不 settle → assemble_video/mergeVideos 卡死 → job 永不结束 → 停止按钮常亮。
// 统一在超时后 SIGKILL 强杀并 reject；kill 后还会再触发一次 close，用 settled 守卫去重。
export function runCapture(bin, args, { timeoutMs = 60_000, onLog, captureStdout = false, isAborted, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    let stderr = '';
    let stdout = '';
    let settled = false;
    let killer;   // 定义在 fail 之后，运行时只被异步事件访问，必已赋值
    let aborter;
    const fail = (e) => { if (settled) return; settled = true; clearTimeout(killer); clearInterval(aborter); reject(e); };
    const done = (v) => { if (settled) return; settled = true; clearTimeout(killer); clearInterval(aborter); resolve(v); };
    killer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      fail(new Error(bin + ' 执行超时（' + Math.round(timeoutMs / 1000) + 's），已强制终止。请检查磁盘空间与源文件是否损坏。'));
    }, timeoutMs);
    // 用户在合并/抽帧途中点了「停止」：直接杀掉 ffmpeg，而不是等这次合并自己跑完
    // （整章合并可达数分钟，停止之后不该还有 CPU 在为用户没在等的产物工作）。
    // 半截产物文件由调用方决定是否清理（与「失败留孤儿文件」的既有口径一致）。
    if (isAborted) {
      aborter = setInterval(() => {
        if (!isAborted()) return;
        try { p.kill('SIGKILL'); } catch {}
        fail(new Error('已停止：' + bin + ' 已被终止'));
      }, 800);
    }
    p.stderr.on('data', (d) => { const s = d.toString(); stderr += s; if (onLog) onLog(s); });
    if (captureStdout) p.stdout.on('data', (d) => { stdout += d.toString(); });
    p.on('error', (e) => fail(new Error(bin + ' 启动失败: ' + e.message)));
    p.on('close', (code) => {
      if (code === 0) done(captureStdout ? stdout : undefined);
      else fail(new Error(bin + (code === null ? ' 被强制终止' : ' 退出码 ' + code) + (stderr ? '：' + stderr.slice(-2000) : '')));
    });
  });
}

export function runFfmpeg(args, { onLog, timeoutMs = 10 * 60 * 1000, isAborted, cwd } = {}) {
  return runCapture('ffmpeg', args, { timeoutMs, onLog, isAborted, cwd });
}

async function probeVideo(inputPath, timeoutMs = 20_000) {
  const out = await runCapture('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', inputPath], { timeoutMs, captureStdout: true });
  try {
    const j = JSON.parse(out);
    const s = (j.streams && j.streams[0]) || {};
    return { width: s.width || 0, height: s.height || 0 };
  } catch {
    throw new Error('ffprobe 解析失败: ' + inputPath);
  }
}

// subtitles：SRT 文本内容（不是文件路径）。传入时把字幕**烧录进画面**（硬字幕），
// 不额外产出 .srt 文件；为实现这一点必须重编码视频。
// upscale：{ scale, sharpen, denoise } 画质增强。非 ffmpeg 的 AI 后端不走这里（要逐帧推理），
// 由 lib/core/video-upscale.js 在合片之后再处理。
export async function mergeVideos(inputPaths, outputPath, { onLog, music, isAborted, subtitles, upscale } = {}) {
  if (!inputPaths.length) throw new Error('没有可合并的视频');
  const musicPath = music?.path || '';
  const volume = music?.volume != null ? Number(music.volume) : 0.25;
  const hasMusic = !!musicPath;
  const subtitleText = String(subtitles || '').trim();
  const hasSubtitles = !!subtitleText;
  // 放大倍率：<=1 视为不增强。用整数判断避免 1.0000001 这类浮点误差误触发重编码。
  const zoom = Number(upscale?.scale) > 1.001 ? Number(upscale.scale) : 1;
  const up = zoom > 1 ? upscale : null;
  // 单段且无背景音乐、无字幕：直接复制（无需重编码，避免无谓开销）
  // 注意：开了画质增强就不能走这条捷径 —— 复制等于原样搬运，超分不会发生。
  if (inputPaths.length === 1 && !hasMusic && !hasSubtitles && !up) { fs.copyFileSync(inputPaths[0], outputPath); return; }

  let tw = 0, th = 0;
  for (const p of inputPaths) {
    const { width, height } = await probeVideo(p);
    if (width > tw) tw = width;
    if (height > th) th = height;
  }
  if (!tw || !th) throw new Error('无法探测视频分辨率');
  tw = tw % 2 ? tw + 1 : tw;
  th = th % 2 ? th + 1 : th;
  // 增强后的目标尺寸：每个分镜直接缩放到该尺寸（保持宽高比 + 补黑边），
  // 而不是「先统一到原始最大值、再整体放大」——后者会让小分镜被放大两次。
  const outW = up ? (Math.round(tw * zoom) % 2 ? Math.round(tw * zoom) + 1 : Math.round(tw * zoom)) : tw;
  const outH = up ? (Math.round(th * zoom) % 2 ? Math.round(th * zoom) + 1 : Math.round(th * zoom)) : th;

  const n = inputPaths.length;
  const args = ['-y'];
  for (const p of inputPaths) args.push('-i', p);
  // 背景音乐作为额外输入（循环播放，混音时按成片音频长度截断）
  let musicIndex = -1;
  if (hasMusic) {
    args.push('-stream_loop', '-1', '-i', musicPath);
    musicIndex = n;
  }

  const vLabels = []; const aLabels = []; const chains = [];
  // 每段的画面链：映射到成片尺寸 → 固定帧率 → 像素格式 → （可选）锐化/降噪。
  // 锐化放在缩放之后：先放大再锐化，边缘才干净；反过来会把插值前的锯齿一起放大。
  let grade = '';
  if (up && up.denoise > 0) grade += ',hqdn3d=' + up.denoise + ':' + up.denoise + ':' + (up.denoise * 2) + ':' + (up.denoise * 3);
  if (up && up.sharpen > 0) grade += ',unsharp=5:5:' + up.sharpen + ':5:5:0';
  for (let i = 0; i < n; i++) {
    const v = 'v' + i, a = 'a' + i;
    chains.push('[' + i + ':v]scale=' + outW + ':' + outH + ':force_original_aspect_ratio=decrease,pad=' + outW + ':' + outH + ':(ow-iw)/2:(oh-ih)/2:color=black,fps=24,format=yuv420p' + grade + ',setpts=PTS-STARTPTS[' + v + ']');
    chains.push('[' + i + ':a]aresample=44100,asetpts=PTS-STARTPTS[' + a + ']');
    vLabels.push(v); aLabels.push(a);
  }
  const concatInputs = [];
  for (let i = 0; i < n; i++) concatInputs.push('[' + vLabels[i] + ']', '[' + aLabels[i] + ']');
  let filter = chains.join(';') + ';' + concatInputs.join('') + 'concat=n=' + n + ':v=1:a=1[vout][aout]';

  let audioOutLabel = 'aout';
  if (hasMusic) {
    // [aout]=拼接后的分镜音频（有限时长，作为 amix 的 first 输入），BGM 循环垫底、音量压低、保留台词。
    // normalize=0 关掉 amix 默认的「按输入路数自动衰减」（默认 normalize=1 会把台词一起压到 1/2），
    // 只让 BGM 按 volume 压低，台词保持原音量——即 ffmpeg 官方 voice+music 混音示例的用法。
    filter += ';[' + musicIndex + ':a]volume=' + volume + '[bgm];[aout][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[amixout]';
    audioOutLabel = 'amixout';
  }

  // 硬字幕：把 SRT 写到临时目录，并让 ffmpeg 以该目录为 cwd、用相对文件名引用。
  // 这样 filter 里不出现盘符/反斜杠/空格，Windows 与 macOS 都不用做转义。
  let videoOutLabel = 'vout';
  let subDir = '';
  if (hasSubtitles) {
    subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-sub-'));
    fs.writeFileSync(path.join(subDir, 'sub.srt'), subtitleText, 'utf8');
    // 字号按画面**宽度**自适应（字幕是横排文字，受宽度约束；竖屏 9:16 宽度小，字号也得小，
    // 否则一行放不下会被换行/裁切）。约 1/36 宽：16:9 720P(1280w)→36、9:16 720P(720w)→20。
    // 必须用增强后的 outW/outH：否则超分放大 2 倍后字幕还是按原尺寸画，在画面上小了一半。
    const fontSize = Math.max(14, Math.round(outW / 36));
    const marginV = Math.max(12, Math.round(outH / 24));
    filter += ';[vout]subtitles=sub.srt:force_style=' + "'FontSize=" + fontSize + ',Outline=1,Shadow=0,MarginV=' + marginV + "'" + '[vsub]';
    videoOutLabel = 'vsub';
  }

  args.push('-filter_complex', filter, '-map', '[' + videoOutLabel + ']', '-map', '[' + audioOutLabel + ']',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-ar', '44100', '-ac', '2',
    '-r', '24', '-movflags', '+faststart', outputPath);

  try {
    await runFfmpeg(args, { onLog, isAborted, cwd: subDir || undefined });
  } finally {
    if (subDir) { try { fs.rmSync(subDir, { recursive: true, force: true }); } catch {} }
  }
}

// 从视频抽取一帧（默认首帧）保存为图片，用于章节卡片预览图等场景。
// -ss 放在 -i 之前做快速 seek，避免从 0 逐帧解码到目标时间点（大视频会慢）。
export async function extractFrame(inputPath, outputPath, { atSec = 0 } = {}) {
  await runFfmpeg(['-y', '-ss', String(atSec), '-i', inputPath, '-frames:v', '1', '-q:v', '2', outputPath], { timeoutMs: 60_000 });
}
