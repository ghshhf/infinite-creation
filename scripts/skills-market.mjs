#!/usr/bin/env node
// 技能市场命令行入口（无界面）。
// 用法：
//   node scripts/skills-market.mjs list                 列出索引里的技能
//   node scripts/skills-market.mjs search 关键词         按名字/描述搜索
//   node scripts/skills-market.mjs installed            列出本机由市场安装的技能
//   node scripts/skills-market.mjs install <名>[@版本]   安装/升级（sha256 强校验）
//   node scripts/skills-market.mjs uninstall <目录名>    卸载（仅限市场安装的）
//   node scripts/skills-market.mjs update               检查可升级项
//   node scripts/skills-market.mjs pack <目录名> [--out 文件]  打包成 zip 并打印索引条目
//
// 索引地址优先级：参数 --registry <url> > config.json 的 skills.registry > 环境变量
// IC_SKILLS_REGISTRY > 仓库内示例索引。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fetchRegistry, registryUrl, installSkill, uninstallSkill,
  checkUpdates, packSkill, listInstalledSkills,
} from '../lib/agent/skill-registry.js';
import { scanSkills } from '../lib/agent/skill-engine.js';
import { loadConfig } from '../lib/core/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
    } else args.push(a);
  }
  return { args, flags };
}

function registryFromFlags(flags) {
  if (flags.registry) return String(flags.registry);
  try { return registryUrl(loadConfig()); } catch { return registryUrl(); }
}

function printTable(rows, cols) {
  if (!rows.length) { console.log('（空）'); return; }
  const widths = cols.map((c) => Math.max(c.title.length, ...rows.map((r) => String(c.get(r) ?? '').length)));
  const line = (cells) => cells.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log(line(cols.map((c) => c.title)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

async function main() {
  const { args, flags } = parseArgs(process.argv.slice(2));
  const cmd = args[0] || 'list';
  const url = registryFromFlags(flags);

  if (cmd === 'list' || cmd === 'search') {
    const reg = await fetchRegistry({ url });
    let list = reg.skills;
    const kw = args[1];
    if (cmd === 'search') {
      if (!kw) throw new Error('用法：search <关键词>');
      const k = kw.toLowerCase();
      list = list.filter((s) => s.name.toLowerCase().includes(k) || s.description.toLowerCase().includes(k));
    }
    printTable(list, [
      { title: 'name', get: (s) => s.name },
      { title: 'latest', get: (s) => s.latest },
      { title: 'versions', get: (s) => s.versions.map((v) => v.version).join(',') },
      { title: 'description', get: (s) => (s.description || '').slice(0, 60) },
    ]);
    console.log('\n索引：' + url + '（共 ' + list.length + ' 项）');
    return;
  }

  if (cmd === 'installed') {
    const list = listInstalledSkills();
    printTable(list, [
      { title: 'dir', get: (s) => s.dir },
      { title: 'version', get: (s) => s.version },
      { title: 'installedAt', get: (s) => new Date(s.installedAt).toLocaleString() },
      { title: 'sha256', get: (s) => String(s.sha256 || '').slice(0, 12) },
    ]);
    if (!list.length) console.log('\n尚未通过市场安装任何技能。仓库自带技能不算在内。');
    return;
  }

  if (cmd === 'install') {
    const spec = args[1];
    if (!spec) throw new Error('用法：install <名>[@版本]');
    const [name, version] = spec.split('@');
    const r = await installSkill(name, { version, url });
    console.log('已安装 ' + r.name + ' → skills/' + r.dir + '（版本 ' + r.version + '，' + r.files + ' 个文件）');
    console.log('sha256 ' + r.sha256);
    const all = scanSkills();
    console.log('技能总数：' + all.length);
    return;
  }

  if (cmd === 'uninstall') {
    const dir = args[1];
    if (!dir) throw new Error('用法：uninstall <目录名>');
    const r = uninstallSkill(dir, { force: !!flags.force });
    console.log('已卸载 skills/' + r.name);
    return;
  }

  if (cmd === 'update') {
    const rows = await checkUpdates({ url });
    printTable(rows, [
      { title: 'dir', get: (r) => r.dir },
      { title: 'installed', get: (r) => r.installed },
      { title: 'latest', get: (r) => r.latest ?? '-' },
      { title: 'status', get: (r) => r.status },
    ]);
    const outdated = rows.filter((r) => r.status === 'outdated');
    if (outdated.length) console.log('\n可升级：直接运行 install <名> 即可。');
    return;
  }

  if (cmd === 'pack') {
    const dir = args[1];
    if (!dir) throw new Error('用法：pack <目录名> [--out 文件]');
    const out = flags.out || path.join(ROOT, 'dist-skills', dir + '.zip');
    const r = packSkill(dir);
    const entry = { ...r.entry, url: flags.base ? String(flags.base).replace(/\/+$/, '') + '/' + dir + '.zip' : r.entry.url };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, r.buffer);
    console.log('已打包 ' + out + '（' + r.size + ' 字节）');
    console.log('sha256 ' + r.sha256);
    console.log('\n粘进索引的条目（把 url 换成实际托管地址）：');
    console.log(JSON.stringify({ name: dir, versions: { '<版本号>': entry } }, null, 2));
    return;
  }

  console.log('未知命令：' + cmd);
  console.log('可用：list / search / installed / install / uninstall / update / pack');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('错误：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
