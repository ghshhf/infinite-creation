import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { installSkillsFromZip, scanSkills } from './skill-engine.js';
import { SKILL_ZIP_MAX_BYTES } from '../shared/index.js';

// 技能市场（registry）：在既有「上传 zip 安装」之上补三件事——
//   ① 可寻址的索引（任意 URL 上的 registry.json）② 版本与校验（sha256 强校验）
//   ③ 可逆（记录来源 + 卸载/回滚）。
//
// 设计前提：技能包 = 带 SKILL.md(frontmatter) 的 zip，与 /api/skills/upload 同一格式，
// 不引入新格式。索引只是「名字 → 版本 → 下载地址 + sha256」的清单，可放在任何静态
// 托管上（GitHub raw / 对象存储 / 内网 nginx），本项目不绑定任何中心服务。
//
// 闭环：packSkill() 把本地技能打成 zip 并算 sha256 → 传到任意 URL → 在索引里登记一条
// → installSkill() 就能在另一台机器装回来。

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SKILLS_DIR = path.join(ROOT, 'skills');
// 安装记录与技能目录同层；不以 SKILL.md 形式存在，scanSkills 不会把它当技能。
const STATE_NAME = '.registry.json';

export const REGISTRY_SCHEMA_VERSION = 1;

// 默认索引指向本项目主分支的示例索引；可用 config.skills.registry 或
// 环境变量 IC_SKILLS_REGISTRY 覆盖成自己的托管地址。
const DEFAULT_REGISTRY_URL = 'https://raw.githubusercontent.com/ghshhf/infinite-creation/main/skills-registry.json';

function skillsDirOf(opts) {
  return opts?.skillsDir || process.env.IC_SKILLS_DIR || DEFAULT_SKILLS_DIR;
}
function stateFileOf(opts) {
  return path.join(skillsDirOf(opts), STATE_NAME);
}

export function registryUrl(cfg) {
  const url = String(cfg?.skills?.registry || process.env.IC_SKILLS_REGISTRY || DEFAULT_REGISTRY_URL || '').trim();
  if (!url) throw new Error('未配置技能索引地址（config.json 的 skills.registry 或环境变量 IC_SKILLS_REGISTRY）');
  return url;
}

export function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// —— 安装记录（本地状态，不入库）——
export function readInstalled(opts) {
  try {
    const j = JSON.parse(fs.readFileSync(stateFileOf(opts), 'utf8'));
    return j && typeof j === 'object' && j.skills ? j : { version: 1, skills: {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

function writeInstalled(state, opts) {
  const dir = skillsDirOf(opts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFileOf(opts), JSON.stringify(state, null, 2) + '\n');
}

// —— 索引解析 ——
// { "version": 1, "skills": [ { "name", "description", "latest",
//     "versions": { "1.0.0": { "url", "sha256", "size" } } } ] }
export function normalizeRegistry(json) {
  if (!json || typeof json !== 'object') throw new Error('索引不是合法的 JSON 对象');
  const v = Number(json.version);
  if (v && v > REGISTRY_SCHEMA_VERSION) {
    throw new Error('索引版本 ' + v + ' 高于本程序支持的 ' + REGISTRY_SCHEMA_VERSION + '，请升级程序');
  }
  const list = Array.isArray(json.skills) ? json.skills : [];
  const skills = [];
  for (const item of list) {
    const name = String(item?.name || '').trim();
    if (!name) continue;
    // 技能名会直接落成安装目录名，先排除路径穿越与非法形态
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      throw new Error('索引中存在非法技能名：' + name);
    }
    const versions = item.versions && typeof item.versions === 'object' ? item.versions : {};
    const entries = Object.entries(versions)
      .map(([ver, meta]) => ({
        version: String(ver),
        url: String(meta?.url || '').trim(),
        sha256: String(meta?.sha256 || '').trim().toLowerCase(),
        size: Number(meta?.size) || 0,
      }))
      .filter((x) => x.url);
    if (!entries.length) continue;
    skills.push({
      name,
      description: String(item.description || ''),
      latest: String(item.latest || '').trim() || entries[entries.length - 1].version,
      versions: entries,
    });
  }
  return { version: REGISTRY_SCHEMA_VERSION, skills };
}

export async function fetchRegistry({ url, timeoutMs = 20_000, baseDir } = {}) {
  const target = url || registryUrl();
  // 本地路径索引：既能离线自测（scripts/build-registry.mjs 刚产出、还没推送到远端时），
  // 也支持内网把索引放在共享盘上。
  if (!/^https?:\/\//i.test(target)) {
    const file = path.isAbsolute(target) ? target : path.resolve(baseDir || process.cwd(), target);
    if (!fs.existsSync(file)) throw new Error('技能索引文件不存在：' + file);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error('技能索引不是合法 JSON：' + e.message);
    }
    return normalizeRegistry(json);
  }
  const res = await fetch(target, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('拉取技能索引失败 ' + res.status + '：' + target);
  let json;
  try {
    json = JSON.parse(await res.text());
  } catch (e) {
    throw new Error('技能索引不是合法 JSON：' + e.message);
  }
  return normalizeRegistry(json);
}

function pickVersion(skill, version) {
  if (version) {
    const hit = skill.versions.find((v) => v.version === String(version));
    if (!hit) {
      throw new Error('技能 ' + skill.name + ' 没有版本 ' + version + '（可用：' + skill.versions.map((v) => v.version).join('、') + '）');
    }
    return hit;
  }
  const hit = skill.versions.find((v) => v.version === skill.latest) || skill.versions[0];
  if (!hit) throw new Error('技能 ' + skill.name + ' 没有可安装的版本');
  return hit;
}

async function downloadZip(entry, { timeoutMs = 60_000, baseDir } = {}) {
  const limit = Math.round(SKILL_ZIP_MAX_BYTES / 1024 / 1024);
  // 与索引一致：非 http(s) 视为本地路径，支持完全离线的内网分发
  if (!/^https?:\/\//i.test(entry.url)) {
    const file = path.isAbsolute(entry.url) ? entry.url : path.resolve(baseDir || process.cwd(), entry.url);
    if (!fs.existsSync(file)) throw new Error('技能包文件不存在：' + file);
    const buf = fs.readFileSync(file);
    if (buf.length > SKILL_ZIP_MAX_BYTES) throw new Error('技能包过大：上限 ' + limit + 'MB');
    return buf;
  }
  const res = await fetch(entry.url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error('下载技能包失败 ' + res.status + '：' + entry.url);
  if (Number(res.headers.get('content-length') || 0) > SKILL_ZIP_MAX_BYTES) {
    throw new Error('技能包过大：上限 ' + limit + 'MB');
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('技能包为空：' + entry.url);
  if (buf.length > SKILL_ZIP_MAX_BYTES) throw new Error('技能包过大：上限 ' + limit + 'MB');
  return buf;
}

// 最终目录名以 skills/ 下真实生成的目录名为准（installSkillsFromZip 会按 frontmatter
// name 或 zip 顶层目录 slugify 得到），不一定等于索引里的 name。
function installInto(buffer, sourceName, opts) {
  const skillsDir = skillsDirOf(opts);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-skill-'));
  try {
    const installed = installSkillsFromZip(buffer, { sourceName, targetDir: tmpRoot });
    if (installed.length !== 1) {
      throw new Error('技能包应只含一个技能，实际含 ' + installed.length + ' 个（' + installed.map((i) => i.name).join('、') + '）');
    }
    const dirName = installed[0].dir;
    const src = path.join(tmpRoot, dirName);
    const dest = path.join(skillsDir, dirName);
    fs.mkdirSync(skillsDir, { recursive: true });

    // 原子替换：旧目录先改名让位，新目录就位后删旧的；中途失败把旧的换回来，
    // 避免「装到一半失败 → 目录半新半旧、却被登记成已安装」。
    const backup = dest + '.bak-' + Date.now();
    const hadOld = fs.existsSync(dest);
    if (hadOld) fs.renameSync(dest, backup);
    try {
      fs.renameSync(src, dest);
    } catch (e) {
      if (hadOld && fs.existsSync(backup) && !fs.existsSync(dest)) fs.renameSync(backup, dest);
      throw e;
    }
    if (hadOld) fs.rmSync(backup, { recursive: true, force: true });
    return { dirName, files: installed[0].files };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// 安装/升级。sha256 是强制项：索引里缺校验和的条目一律拒绝，
// 否则「市场」就退化成「任意远端代码一键落盘」。
export async function installSkill(name, { version, url, timeoutMs, ...opts } = {}) {
  const registry = await fetchRegistry({ url, timeoutMs });
  const skill = registry.skills.find((s) => s.name === name);
  if (!skill) throw new Error('索引中没有技能：' + name);
  const entry = pickVersion(skill, version);
  if (!entry.sha256) {
    throw new Error('技能 ' + name + '@' + entry.version + ' 缺少 sha256，拒绝安装（索引必须提供校验和）');
  }

  const buf = await downloadZip(entry, { timeoutMs });
  const actual = computeSha256(buf);
  if (actual !== entry.sha256) {
    throw new Error('技能包校验失败（sha256 不一致）：期望 ' + entry.sha256 + '，实际 ' + actual);
  }
  if (entry.size && buf.length !== entry.size) {
    throw new Error('技能包大小不符：期望 ' + entry.size + ' 字节，实际 ' + buf.length);
  }

  const { dirName, files } = installInto(buf, name + '.zip', opts);
  const state = readInstalled(opts);
  state.skills[dirName] = {
    name,
    version: entry.version,
    sha256: actual,
    size: buf.length,
    source: entry.url,
    registry: url || registryUrl(),
    files,
    installedAt: Date.now(),
  };
  writeInstalled(state, opts);
  if (!opts.skillsDir) scanSkills(); // 装进真实目录才刷新技能表；测试写临时目录不污染
  return { name, dir: dirName, version: entry.version, sha256: actual, files };
}

// 卸载：默认只删「市场装进来的」，避免一条命令删掉仓库自带技能。
export function uninstallSkill(dirName, { force = false, ...opts } = {}) {
  const state = readInstalled(opts);
  const rec = state.skills[dirName];
  if (!rec && !force) {
    throw new Error(dirName + ' 不是通过技能市场安装的，拒绝卸载（确需删除请传 force）');
  }
  const dest = path.join(skillsDirOf(opts), String(dirName || ''));
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  if (rec) {
    delete state.skills[dirName];
    writeInstalled(state, opts);
  }
  if (!opts.skillsDir) scanSkills();
  return { name: dirName, removed: true };
}

// 本地已装 vs 索引 latest，用于「检查更新」。
export async function checkUpdates({ url, timeoutMs, ...opts } = {}) {
  const registry = await fetchRegistry({ url, timeoutMs });
  const state = readInstalled(opts);
  const out = [];
  for (const [dirName, rec] of Object.entries(state.skills)) {
    const skill = registry.skills.find((s) => s.name === (rec.name || dirName));
    if (!skill) {
      out.push({ dir: dirName, name: rec.name || dirName, installed: rec.version, latest: null, status: 'missing' });
      continue;
    }
    out.push({
      dir: dirName,
      name: rec.name || dirName,
      installed: rec.version,
      latest: skill.latest,
      status: skill.latest === rec.version ? 'current' : 'outdated',
    });
  }
  return out;
}

// 把本地技能打成可分发的 zip，并给出可直接粘进索引的 versions 条目。
// 遇到符号链接或超限直接拒绝（产物必须能安全解包）。
export function packSkill(dirName, { skillsDir, releaseBaseUrl = '' } = {}) {
  const base = skillsDir || DEFAULT_SKILLS_DIR;
  const dir = path.join(base, String(dirName || ''));
  if (!dirName || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('技能目录不存在：' + dirName);
  }
  // 直接查目录里的技能入口文件，而不是走 skill-engine 的 readSkillFile ——
  // 后者固定读真实 skills/ 目录，注入 skillsDir 时会误判。
  if (!['SKILL.md', 'SKILL.cn.md'].some((f) => fs.existsSync(path.join(dir, f)))) {
    throw new Error(dirName + ' 不是技能目录（缺少 SKILL.md）');
  }

  const zip = new AdmZip();
  let total = 0;
  const walk = (abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const full = path.join(abs, e.name);
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) throw new Error('技能目录含符号链接，拒绝打包：' + full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) continue;
      total += st.size;
      if (total > SKILL_ZIP_MAX_BYTES) {
        throw new Error('技能包超过上限 ' + Math.round(SKILL_ZIP_MAX_BYTES / 1024 / 1024) + 'MB');
      }
      // 保留一层技能目录名，解包后仍是「一个技能目录」而不是散落文件
      const sub = path.relative(dir, path.dirname(full)).replace(/\\/g, '/');
      zip.addLocalFile(full, sub ? dirName + '/' + sub : dirName);
    }
  };
  walk(dir);

  const buffer = zip.toBuffer();
  const sha256 = computeSha256(buffer);
  return {
    buffer,
    sha256,
    size: buffer.length,
    // 托管地址由调用方决定（任意静态托管），这里只负责算好校验和与大小
    entry: {
      url: releaseBaseUrl ? releaseBaseUrl.replace(/\/+$/, '') + '/' + dirName + '.zip' : '',
      sha256,
      size: buffer.length,
    },
  };
}

export function listInstalledSkills(opts) {
  const state = readInstalled(opts);
  return Object.entries(state.skills).map(([dir, rec]) => ({ dir, ...rec }));
}
