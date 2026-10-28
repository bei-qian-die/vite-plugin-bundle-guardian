/**
 * 数据访问层（backend）
 *
 * 页面所有「需要跨刷新留存」的数据都只能通过这里读写，UI 层不直接碰 SDK，
 * 也不自己拼 /.cloud/** 请求 —— 换后端实现时只动这一个文件。
 *
 * 当前实现：CloudBackend（WorkBuddy 云服务）
 *   · Auth     —— 手机号验证码登录，会话持久化与刷新由 SDK 负责
 *   · Database —— analysis_records，RLS 按 owner_id 隔离，每人只看得到自己的记录
 *   · Storage  —— 完整报告 JSON：users/<uid>/... 私有；点了分享才复制一份到 shared/<uid>/...
 *
 * 为什么报告全文放 Storage 而不是塞进数据库字段：
 * 报告含 sourcemap 模块图，单份 300–400 KB，放进表里既拖慢列表查询也会撞上行大小限制；
 * 表里只留指标摘要（也正好是列表要展示的东西），点「载入」时才按需取全文。
 */

import { cloud } from './cloud.js';
import type { Report } from './types.js';

/* ────────────────────────── 数据模型 ────────────────────────── */

export interface Metrics {
  assetCount: number;
  totalRaw: number;
  totalGzip: number;
  totalBrotli: number;
  errorCount: number;
  warnCount: number;
  packageCount: number;
}

export interface AnalysisRecord {
  id: string;
  label: string;
  savedAt: number;
  metrics: Metrics;
  /** Storage 里的对象名（reports/<uuid>.json），配合 shared 决定取 users/ 还是 shared/ */
  reportKey: string | null;
  shared: boolean;
  isBaseline: boolean;
}

export interface AccountInfo {
  id: string;
  name?: string;
  phone?: string;
  avatarUrl?: string;
}

/** 一次发码的结果，UI 要在验码时原样带回来 */
export interface PendingOtp {
  phone: string;
  verificationId: string;
  isExistingUser: boolean;
}

export interface Backend {
  readonly kind: 'cloud';
  readonly label: string;
  /** 启动：恢复已有会话 */
  init(): Promise<void>;
  account(): AccountInfo | null;
  /** 是否已登录 —— 未登录时用户级数据一律不读写 */
  signedIn(): boolean;
  sendPhoneCode(phone: string): Promise<PendingOtp>;
  verifyPhoneCode(pending: PendingOtp, token: string): Promise<AccountInfo>;
  signOut(): Promise<void>;
  /** 登录态变化回调，返回取消订阅函数 */
  onAccountChange(cb: (acc: AccountInfo | null) => void): () => void;
  listRecords(): Promise<AnalysisRecord[]>;
  /** 归档一份报告：先传全文到私有目录，再插一行指标 */
  saveRecord(label: string, report: Report): Promise<AnalysisRecord>;
  /** 按需取回某条记录的完整报告 */
  loadReport(rec: AnalysisRecord): Promise<Report>;
  deleteRecord(id: string): Promise<void>;
  clearRecords(): Promise<void>;
  /** 把某条记录设为对比基线（同一账号下只会有一条） */
  setBaseline(id: string): Promise<void>;
  /** 把某条记录复制一份到 shared/ 使其可被其他登录用户打开 */
  shareRecord(id: string): Promise<string>;
  /** 打开分享链接：取回 shared/ 下的报告全文 */
  loadShared(sharedPath: string): Promise<Report>;
}

/* ────────────────────────── 工具 ────────────────────────── */

const TABLE = 'analysis_records';
/** 列表最多显示多少条 */
const LIST_LIMIT = 50;

/** 报告签名：同一份报告重复载入 / 刷新页面时不要堆出多条历史 */
function sigOf(r: Report): string {
  return `${r.tool}@${r.at}:${r.summary.totalGzip}:${r.summary.assetCount}`;
}

function metricsOf(r: Report): Metrics {
  return {
    assetCount: r.summary.assetCount,
    totalRaw: r.summary.totalRaw,
    totalGzip: r.summary.totalGzip,
    totalBrotli: r.summary.totalBrotli,
    errorCount: r.summary.errorCount,
    warnCount: r.summary.warnCount,
    packageCount: Array.isArray(r.packages) ? r.packages.length : 0
  };
}

function toAccount(s: { user: { id: string; name?: string; phone?: string; avatarUrl?: string } }): AccountInfo {
  return {
    id: s.user.id,
    name: s.user.name,
    phone: s.user.phone,
    avatarUrl: s.user.avatarUrl
  };
}

/** 数据库行 → 前端记录 */
function toRecord(row: Record<string, unknown>): AnalysisRecord {
  return {
    id: String(row.id),
    label: String(row.label ?? ''),
    savedAt: row.saved_at ? new Date(String(row.saved_at)).getTime() : Date.now(),
    metrics: {
      assetCount: Number(row.asset_count ?? 0),
      totalRaw: Number(row.total_raw ?? 0),
      totalGzip: Number(row.total_gzip ?? 0),
      totalBrotli: Number(row.total_brotli ?? 0),
      errorCount: Number(row.error_count ?? 0),
      warnCount: Number(row.warn_count ?? 0),
      packageCount: Number(row.package_count ?? 0)
    },
    reportKey: row.report_key ? String(row.report_key) : null,
    shared: Boolean(row.shared),
    isBaseline: Boolean(row.is_baseline)
  };
}

function newKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把 SDK 返回的 error 变成一句能给人看的话。
 * 只取 message，不把整个 error 对象或任何凭据打进日志。
 */
function errText(e: unknown, fallback: string): string {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg.trim() ? msg : fallback;
}

/** SDK 各模块的错误对象不一定都带 status 字段，兜底再从消息文本里认一次 */
function isAuthError(e: unknown): boolean {
  const st = (e as { status?: unknown } | null)?.status;
  if (st === 401 || st === 403) return true;
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && /\bHTTP 40[13]\b/.test(msg);
}

/* ────────────────────────── 云端实现 ────────────────────────── */

class CloudBackend implements Backend {
  readonly kind = 'cloud' as const;
  readonly label = '云服务';
  private acc: AccountInfo | null = null;
  private cache: AnalysisRecord[] = [];
  private listeners = new Set<(acc: AccountInfo | null) => void>();
  private saving: Promise<AnalysisRecord> | null = null;

  async init(): Promise<void> {
    const { data: session, error } = await cloud.auth.getSession();
    this.acc = error || !session ? null : toAccount(session);

    /* 会话刷新、登出都走这里，UI 只管重画 */
    cloud.auth.onAuthStateChange((_event, session) => {
      this.acc = session ? toAccount(session) : null;
      if (!this.acc) this.cache = [];
      for (const cb of this.listeners) cb(this.acc);
    });

    if (this.acc) this.cache = await this.fetchRecords();
  }

  account(): AccountInfo | null {
    return this.acc;
  }

  signedIn(): boolean {
    return this.acc !== null;
  }

  onAccountChange(cb: (acc: AccountInfo | null) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 未登录时读写用户数据会撞 RLS，先在这里拦掉，给一句人话 */
  private requireAccount(): AccountInfo {
    if (!this.acc) throw new Error('请先登录后再使用同步功能');
    return this.acc;
  }

  /**
   * 401/403 兜底：先强刷一次会话再重试。
   * 多标签页场景下刷新令牌是轮换的，旧标签页的 access token 过期后
   * SDK 内部不一定自动续（尤其 403 不在它的刷新触发条件里），
   * 这里显式刷一次；刷不动就登出并告诉用户重新登录，而不是留一个假登录态。
   */
  private async withAuthRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (!isAuthError(e)) throw e;
      const refreshed = await cloud.auth.refreshSession();
      if (refreshed.error || !refreshed.data) {
        this.acc = null;
        for (const cb of this.listeners) cb(null);
        throw new Error('登录已过期，请退出后重新登录');
      }
      this.acc = toAccount(refreshed.data);
      for (const cb of this.listeners) cb(this.acc);
      return await op();
    }
  }

  private async fetchRecords(): Promise<AnalysisRecord[]> {
    const { data, error } = await this.withAuthRetry(() =>
      cloud.database.from(TABLE).select('*').order('saved_at', { ascending: false }).limit(LIST_LIMIT)
    );
    if (error) throw new Error(errText(error, '读取历史记录失败'));
    return (data ?? []).map((row) => toRecord(row as Record<string, unknown>));
  }

  async listRecords(): Promise<AnalysisRecord[]> {
    if (!this.acc) return [];
    this.cache = await this.fetchRecords();
    return this.cache.slice();
  }

  async sendPhoneCode(phone: string): Promise<PendingOtp> {
    if (!/^1\d{10}$/.test(phone)) {
      throw new Error('请输入正确的 11 位手机号');
    }
    /*
     * 发码与验码必须是两个独立的用户动作：
     * 这里只发码，把 verificationId / isExistingUser 交给调用方存着，
     * 验码那一步再原样带回来。重试验证码时也绝不重新发码。
     */
    const sent = await cloud.auth.sendOtp({ phone });
    if (sent.error) throw new Error(errText(sent.error, '验证码发送失败，请稍后重试'));
    return {
      phone,
      verificationId: sent.data.verificationId,
      isExistingUser: sent.data.isExistingUser
    };
  }

  async verifyPhoneCode(pending: PendingOtp, token: string): Promise<AccountInfo> {
    const clean = token.trim();
    if (!/^\d{4,8}$/.test(clean)) throw new Error('请输入验证码');
    const done = await cloud.auth.verifyOtp({
      phone: pending.phone,
      verificationId: pending.verificationId,
      isExistingUser: pending.isExistingUser,
      token: clean
    });
    if (done.error) throw new Error(errText(done.error, '验证码不正确或已过期'));
    this.acc = toAccount(done.data);
    this.cache = await this.fetchRecords();
    for (const cb of this.listeners) cb(this.acc);
    return this.acc;
  }

  async signOut(): Promise<void> {
    await cloud.auth.signOut();
    this.acc = null;
    this.cache = [];
    for (const cb of this.listeners) cb(null);
  }

  async saveRecord(label: string, report: Report): Promise<AnalysisRecord> {
    const acc = this.requireAccount();
    /* 并发归档串行化：boot 自动载入示例 + 手动上传同时发生时，两个都过不去重就都插进去了 */
    const run = this.saving;
    this.saving = (async () => {
      try {
        return await run;
      } catch {
        return null;
      }
    })().then(() => this.doSaveRecord(acc, label, report));
    try {
      return await this.saving;
    } finally {
      this.saving = null;
    }
  }

  private async doSaveRecord(acc: AccountInfo, label: string, report: Report): Promise<AnalysisRecord> {
    const sig = sigOf(report);

    /* 去重：同一签名的记录已存在就直接复用，不再上传 / 插行 */
    const dup = await this.withAuthRetry(() =>
      cloud.database.from(TABLE).select('*').eq('sig', sig).limit(1)
    );
    if (!dup.error) {
      const rows = (dup.data ?? []) as Array<Record<string, unknown>>;
      if (rows.length) return toRecord(rows[0]);
    }

    const key = `${newKey()}.json`;
    const path = cloud.storage.userPath(acc.id, `reports/${key}`);
    const body = JSON.stringify(report);

    const uploaded = await this.withAuthRetry(() =>
      cloud.storage.upload(path, body, {
        contentType: 'application/json',
        upsert: false
      })
    );
    if (uploaded.error) throw new Error(`上传报告失败：${errText(uploaded.error, '报告上传失败')}`);

    const m = metricsOf(report);
    /*
     * 注意：这里不传 owner_id —— 表里是 DEFAULT auth.uid()，由数据库填，
     * 而且 INSERT 策略会校验 owner_id = auth.uid()，伪造会被拒。
     */
    const { data, error } = await this.withAuthRetry(() =>
      cloud.database
        .from(TABLE)
        .insert({
          label,
          saved_at: new Date().toISOString(),
          asset_count: m.assetCount,
          total_raw: m.totalRaw,
          total_gzip: m.totalGzip,
          total_brotli: m.totalBrotli,
          error_count: m.errorCount,
          warn_count: m.warnCount,
          package_count: m.packageCount,
          report_key: key,
          sig,
          shared: false,
          is_baseline: false
        })
        .select()
    );

    if (error) {
      /* 行没写进去，别把 Storage 里的文件留成孤儿 */
      await cloud.storage.remove([path]).catch(() => undefined);
      throw new Error(errText(error, '记录保存失败'));
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (!rows.length) {
      await cloud.storage.remove([path]).catch(() => undefined);
      throw new Error('记录保存失败：没有写入权限');
    }

    this.cache = await this.fetchRecords();
    return toRecord(rows[0]);
  }

  async loadReport(rec: AnalysisRecord): Promise<Report> {
    const acc = this.requireAccount();
    if (!rec.reportKey) throw new Error('这条记录没有关联报告文件');
    const path = rec.shared
      ? cloud.storage.sharedPath(acc.id, `reports/${rec.reportKey}`)
      : cloud.storage.userPath(acc.id, `reports/${rec.reportKey}`);

    const { data, error } = await this.withAuthRetry(() => cloud.storage.download(path));
    if (error) throw new Error(errText(error, '报告读取失败'));
    const text = await data.text();
    try {
      return JSON.parse(text) as Report;
    } catch {
      throw new Error('报告文件已损坏，无法解析');
    }
  }

  async deleteRecord(id: string): Promise<void> {
    const acc = this.requireAccount();
    const rec = this.cache.find((r) => r.id === id);
    const { data, error } = await this.withAuthRetry(() =>
      cloud.database.from(TABLE).delete().eq('id', id).select()
    );
    if (error) throw new Error(errText(error, '删除失败'));
    /*
     * 空数组 = 这条要么不存在、要么不是当前用户的（被 RLS 过滤了），
     * 不能当成删除成功。
     */
    const removed = Array.isArray(data) ? data : [];
    if (!removed.length) throw new Error('没有删除任何记录 —— 它可能不存在，或者不属于当前账号');

    if (rec?.reportKey) {
      await cloud.storage
        .remove([cloud.storage.userPath(acc.id, `reports/${rec.reportKey}`)])
        .catch(() => undefined);
    }
    this.cache = await this.fetchRecords();
  }

  async clearRecords(): Promise<void> {
    const acc = this.requireAccount();
    const all = await this.fetchRecords();
    const keys = all
      .filter((r) => r.reportKey)
      .map((r) => cloud.storage.userPath(acc.id, `reports/${r.reportKey as string}`));

    /* 有筛选条件的删除，不是 DELETE FROM table —— 且 RLS 只会放行属于自己的行 */
    const { error } = await this.withAuthRetry(() =>
      cloud.database.from(TABLE).delete().gt('id', 0)
    );
    if (error) throw new Error(errText(error, '清空失败'));
    if (keys.length) await cloud.storage.remove(keys).catch(() => undefined);
    this.cache = [];
  }

  async setBaseline(id: string): Promise<void> {
    this.requireAccount();
    /*
     * 两步：先把其它行清成 false，再给目标行打上 true。
     * 两条 UPDATE 都带条件，RLS 只会放行属于自己的行，动不到别人的数据。
     */
    const cleared = await this.withAuthRetry(() =>
      cloud.database.from(TABLE).update({ is_baseline: false }).neq('id', id)
    );
    if (cleared.error) throw new Error(errText(cleared.error, '基线更新失败'));

    const { data, error } = await this.withAuthRetry(() =>
      cloud.database
        .from(TABLE)
        .update({ is_baseline: true })
        .eq('id', id)
        .select()
    );
    if (error) throw new Error(errText(error, '基线更新失败'));

    /* 空数组 = 这条不存在或不属于当前账号，别当成成功 */
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) throw new Error('基线设置失败：这条记录不存在或不属于当前账号');

    this.cache = await this.fetchRecords();
  }

  async shareRecord(id: string): Promise<string> {
    const acc = this.requireAccount();
    const rec = this.cache.find((r) => r.id === id);
    if (!rec?.reportKey) throw new Error('这条记录没有关联报告文件，无法生成分享链接');

    const from = cloud.storage.userPath(acc.id, `reports/${rec.reportKey}`);
    const to = cloud.storage.sharedPath(acc.id, `reports/${rec.reportKey}`);

    if (!rec.shared) {
      const copied = await this.withAuthRetry(() => cloud.storage.copy(from, to));
      if (copied.error) throw new Error(errText(copied.error, '分享失败'));
    }

    const { data, error } = await this.withAuthRetry(() =>
      cloud.database
        .from(TABLE)
        .update({ shared: true })
        .eq('id', id)
        .select()
    );
    if (error) throw new Error(errText(error, '分享状态更新失败'));
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) throw new Error('分享失败：这条记录不属于当前账号');

    this.cache = await this.fetchRecords();
    return to;
  }

  async loadShared(sharedPath: string): Promise<Report> {
    this.requireAccount();
    /* 分享路径只允许落在 shared/ 下，别把任意 key 交给 download */
    if (!sharedPath.startsWith('shared/')) throw new Error('分享链接无效');
    const { data, error } = await this.withAuthRetry(() => cloud.storage.download(sharedPath));
    if (error) throw new Error(errText(error, '分享内容读取失败'));
    try {
      return JSON.parse(await data.text()) as Report;
    } catch {
      throw new Error('分享内容已损坏，无法解析');
    }
  }
}

/* ────────────────────────── 导出 ────────────────────────── */

export const backend: Backend = new CloudBackend();

export { metricsOf };
