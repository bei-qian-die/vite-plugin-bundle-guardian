/**
 * VSCode / 编辑器问题面板格式
 *
 * 把诊断输出成 `file:line:col: severity: message [ruleId]`，
 * VSCode 的 problem matcher（以及大部分编辑器的 output parser）都能识别，
 * 于是体积问题会直接出现在「问题」面板里，点一下就跳到那行。
 *
 * 这比写一个专门的 VSCode 扩展性价比高得多 —— 编辑器侧只需要一段 tasks.json。
 */

import path from 'node:path';
import type { AnalysisResult, Diagnostic } from '../types.js';

const SEVERITY: Record<string, string> = {
  error: 'error',
  warn: 'warning',
  info: 'info',
};

/**
 * 从文件路径里剥出行号（部分规则的 where 里带 :line）。
 * 两个清洗动作是必需的，否则问题面板会被噪音淹没：
 *   - 循环依赖的 where 是一整条 "a → b → a"，只取第一段
 *   - node_modules 下的路径没有跳转价值（而且极长），直接丢弃
 */
function splitLocation(where: string | undefined): { file: string; line: number; col: number } | null {
  if (!where) return null;
  const head = where.split('→')[0].trim();
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(head);
  const file = m ? m[1] : head;
  if (!file) return null;
  if (file.includes('node_modules')) return null;
  return { file, line: m ? Number(m[2]) : 1, col: m ? Number(m[3] ?? 1) : 1 };
}

export function renderVscodeProblems(result: AnalysisResult): string {
  const lines: string[] = [];
  const root = result.root;

  for (const d of result.diagnostics) {
    const loc = splitLocation(d.where);
    if (!loc) continue;
    // Windows 的 path.relative 会给出反斜杠，统一成正斜杠 —— 编辑器的 problem matcher 认这个
    const file = (path.isAbsolute(loc.file) ? path.relative(root, loc.file) : loc.file).replace(/\\/g, '/');
    lines.push(
      `${file}:${loc.line}:${loc.col}: ${SEVERITY[d.level] ?? 'info'}: ${d.msg}${d.fix ? ` → ${d.fix}` : ''} [${d.ruleId}]`
    );
  }

  // 预算超标没有源码位置，指向产物本身
  for (const b of result.budgets) {
    if (b.level === 'ok') continue;
    const target = b.target ?? b.offenders[0];
    if (!target) continue;
    const file = (path.isAbsolute(target) ? path.relative(root, target) : target).replace(/\\/g, '/');
    lines.push(
      `${file}:1:1: ${SEVERITY[b.level]}: 预算 ${b.name} 超限：${Math.round(b.ratio * 100)}% [budget/${b.name}]`
    );
  }

  return lines.join('\n');
}

/** 配套的 tasks.json 片段，直接给用户抄 */
export function vscodeTaskSnippet(): string {
  return JSON.stringify(
    {
      version: '2.0.0',
      tasks: [
        {
          label: 'bundle-guardian: check',
          type: 'shell',
          command: 'npx bundle-guardian check dist --format vscode',
          problemMatcher: {
            owner: 'bundle-guardian',
            pattern: {
              regexp: '^(.+):(\\d+):(\\d+):\\s+(error|warning|info):\\s+(.*)\\s+\\[(.*)\\]$',
              file: 1,
              line: 2,
              column: 3,
              severity: 4,
              message: 5,
              code: 6,
            },
          },
        },
      ],
    },
    null,
    2
  );
}
