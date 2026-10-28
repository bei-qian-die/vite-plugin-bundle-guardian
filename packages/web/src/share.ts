/**
 * 分享与导出
 *
 * 报告单份 300–400 KB，塞进 URL 会超长（多数浏览器/聊天软件 32 KB 就截断），
 * 所以分享时把全文上传到 Storage 的 shared/ 目录，链接里只带一个对象名 ——
 * 长度从几百 KB 降到几十字节，且任何登录用户都能打开。
 */

/** 生成分享链接：保留当前 pathname 与 sharecode，只改 hash */
export function buildShareLink(sharedPath: string): string {
  const url = new URL(location.href);
  url.hash = 's=' + sharedPath;
  return url.href;
}

/** 触发浏览器下载 */
export function download(name: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: mime });
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 2000);
}

/** 复制到剪贴板；非安全上下文下 Clipboard API 不可用，退回 execCommand */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && location.protocol !== 'http:') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
