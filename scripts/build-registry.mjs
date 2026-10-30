#!/usr/bin/env node
// 发布端：把 skills/ 下的技能打成可分发包，产出 dist-skills/*.zip 与 skills-registry.json。
// 用法：node scripts/build-registry.mjs [技能目录名...]
//      不带参数时发布 DEFAULT_PUBLISH 里列出的技能（其余技能留在仓库里直接可用，不必打市场包）。
//
// 版本策略：本脚本对同一技能重复运行会覆盖同名 zip 并把索引里的该版本就地更新，
// 版本号默认取 package.json 的 version（技能包与项目同版），需要独立版本时用 --version 指定。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packSkill } from '../lib/agent/skill-registry.js';
import { parseFrontmatter } from '../lib/agent/skill-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(ROOT, 'skills');
const OUT_DIR = path.join(ROOT, 'dist-skills');
const INDEX_FILE = path.join(ROOT, 'skills-registry.json');

// 发布用的 raw 前缀：换成你自己的仓库/域名即可（任何静态托管都行）。
const RAW_BASE = 'https://raw.githubusercontent.com/ghshhf/infinite-creation/main/dist-skills';

// 默认只发布体积小、通用性强的技能；大包（如 6MB 的 music-caption-rewriter）留给仓库内直用。
const DEFAULT_PUBLISH = [
  'novel-to-video',
  'tts-voice-design',
  'image-prompt-writing',
  'script-to-storyboard',
  'novel-to-skitscreenplay',
  'micro-drama-creator',
  'era-consistency-optimizer',
  'ai-music-studio',
];

function main() {
  const args = process.argv.slice(2);
  const versionFlagIdx = args.indexOf('--version');
  const version = versionFlagIdx >= 0 ? args[versionFlagIdx + 1] : JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const names = args.filter((a, i) => !a.startsWith('--') && i !== versionFlagIdx + 1);
  const publish = names.length ? names : DEFAULT_PUBLISH;

  let index = { version: 1, skills: [] };
  if (fs.existsSync(INDEX_FILE)) {
    try { index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch { /* 索引损坏就重建 */ }
  }
  if (!Array.isArray(index.skills)) index.skills = [];
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const published = [];
  for (const name of publish) {
    const dir = path.join(SKILLS_DIR, name);
    if (!fs.existsSync(dir)) {
      console.warn('[skip] 技能不存在：' + name);
      continue;
    }
    const packed = packSkill(name);
    fs.writeFileSync(path.join(OUT_DIR, name + '.zip'), packed.buffer);

    const entry = { url: RAW_BASE + '/' + name + '.zip', sha256: packed.sha256, size: packed.size };
    let skill = index.skills.find((s) => s.name === name);
    if (!skill) {
      skill = { name, description: readDescription(dir), latest: version, versions: {} };
      index.skills.push(skill);
    }
    skill.versions = skill.versions || {};
    skill.versions[version] = entry;
    skill.latest = version;
    if (!skill.description) skill.description = readDescription(dir);
    published.push({ name, version, size: packed.size, sha256: packed.sha256 });
  }

  index.version = 1;
  index.skills.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + '\n');

  console.log('已发布 ' + published.length + ' 个技能包 → dist-skills/');
  for (const p of published) {
    console.log('  ' + p.name.padEnd(28) + (p.size / 1024).toFixed(1).padStart(8) + ' KB  ' + p.sha256.slice(0, 16));
  }
  console.log('\n索引已写入 ' + path.relative(ROOT, INDEX_FILE) + '（共 ' + index.skills.length + ' 项）');
}

function readDescription(dir) {
  for (const f of ['SKILL.md', 'SKILL.cn.md']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    // 用项目自己的 frontmatter 解析器，避免和技能加载路径的解析规则出现两套
    const meta = parseFrontmatter(fs.readFileSync(p, 'utf8'));
    if (meta.description) return String(meta.description).slice(0, 200);
  }
  return '';
}

main();
