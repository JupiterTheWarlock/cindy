/**
 * libraryBinding.ts — Library 自定义存储位置的持久 binding(2026-08-20 定案)。
 * ---------------------------------------------------------------------------
 * 装入确认框「更改…」/设置页随时迁移都由**宿主**发起,裁决结果落 owner-scoped
 * `libraries-binding.json`(与 pick-grants 同族:用户亲选事实,卸载/重装不清);
 * 插件永远接触不到该文件,也拿不到其中任何绝对路径。
 *
 * 漂移纪律(fail closed,绝不当空库):
 *   - realpath(root) 解析失败 → disk-missing(外接盘拔出/目录被删);
 *   - 解析成功但与授权快照不符(路径变了,或 grant 时记录了有效文件 identity
 *     而现在对不上——目录被删后原地重建)→ binding-moved,要求用户重新确认,
 *     绝不静默跟随到新目标。
 *   - identity 在 Windows 上不可靠(st_ino 多为 0):ino 为 0 时跳过 identity
 *     比对,只比路径字符串——「同路径删后重建」在 Windows 检不出来,这是已知
 *     平台限制,如实记入方案文档,不假装已覆盖。
 *
 * 与 dir/save_dir 一次性票据**不共享存储、不共享校验入口**:十分钟内存票据
 * 升级不成持久授权,持久授权也不借票据通道。
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 单个插件的自定义位置记录。 */
export interface LibraryBindingRecord {
  /** 用户所选父目录(裁决时刻的 canonical realpath)。 */
  root: string;
  /** 授权快照:realpath(root) @grant;打开时重解比对。 */
  realPathAtGrant: string;
  /** grant 时刻根目录的文件 identity(dev/ino);ino=0 视为「平台不提供」。 */
  identity: { dev: number; ino: number } | null;
  grantedAt: number;
  /** 每次重新绑定递增;迁移切换时原子写入。 */
  generation: number;
}

export interface LibraryBindingFileData {
  version: 1;
  bindings: Record<string, LibraryBindingRecord>;
}

export type LibraryLocationResolution =
  | { kind: 'default'; root: string }
  | { kind: 'custom'; root: string; record: LibraryBindingRecord }
  | { kind: 'custom'; root: null; drift: 'binding-moved' | 'disk-missing'; record: LibraryBindingRecord };

export interface LibraryBindingDeps {
  /** owner-scoped libraries-binding.json 的绝对路径(生产注入;测试 tmpdir)。 */
  getFile(): string;
  /** 宿主受管根列表(userData、owners 树等):自定义库根不得落在其内。 */
  getManagedRoots(): string[];
  /** 系统默认库根(无 binding 时的解析结果)。 */
  getDefaultRoot(ghostId: string): string;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?(): number;
}

/** 候选位置校验失败(独立类型,便于 setBinding 返回值判别收窄)。 */
export type LocationValidationFailure = {
  ok: false;
  errorCode: 'PATH_INVALID' | 'LIBRARY_UNAVAILABLE' | 'DISK_FULL';
  message: string;
};

/** 候选位置校验结果:ok 时可能带云盘等警告(允许但必须向用户如实展示)。 */
export type LocationValidation =
  | { ok: true; libraryRoot: string; warnings: string[] }
  | LocationValidationFailure;

/** 已知云同步目录特征(路径子串,大小写不敏感;命中 → 强警告,不阻断)。 */
const CLOUD_SYNC_MARKERS = ['mobile documents', 'dropbox', 'onedrive', 'icloud', 'google drive', 'googledrive'];

function foldCasePath(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isInsideDir(base: string, target: string): boolean {
  const b = foldCasePath(path.resolve(base));
  const t = foldCasePath(path.resolve(target));
  return t === b || t.startsWith(b + path.sep);
}

/**
 * 候选位置校验:可写探针、受管根排斥、网络盘拒绝(Windows UNC)、云同步目录
 * 强警告、剩余空间检查。candidate 是**用户所选父目录**;实际库根 =
 * `<candidate>/<ghostId>`(用 ghostId 不用展示名:稳定、ASCII 安全,两个插件
 * 指向同一父目录也不互踩)。
 */
export async function validateLibraryCandidateLocation(req: {
  candidate: string;
  ghostId: string;
  deps: LibraryBindingDeps;
  getDiskFreeBytes?: (root: string) => Promise<number | null>;
}): Promise<LocationValidation> {
  const { candidate, ghostId, deps } = req;
  if (typeof candidate !== 'string' || candidate.length === 0 || !path.isAbsolute(candidate)) {
    return { ok: false, errorCode: 'PATH_INVALID', message: '目录必须是绝对路径' };
  }
  // Windows UNC(\\server\share)按网络盘拒:映射盘符检测需要 Win32 API,
  // v1 不假装覆盖(方案文档记录为已知限制)。
  if (candidate.startsWith('\\\\')) {
    return { ok: false, errorCode: 'PATH_INVALID', message: '不支持网络位置(UNC);请选择本机目录——SQLite 放在网络盘会损坏' };
  }
  const libraryRoot = path.join(candidate, ghostId);
  for (const managed of deps.getManagedRoots()) {
    if (isInsideDir(managed, libraryRoot)) {
      return { ok: false, errorCode: 'PATH_INVALID', message: '所选目录位于 Cindy 管理的数据区内;请选择其它位置' };
    }
  }
  const warnings: string[] = [];
  const folded = foldCasePath(candidate);
  for (const marker of CLOUD_SYNC_MARKERS) {
    if (folded.includes(marker)) {
      warnings.push('所选目录看起来由云同步服务管理(iCloud/OneDrive/Dropbox 等);数据库文件被云同步改写可能导致损坏,建议改用普通本地目录');
      break;
    }
  }
  // 可写探针:创建+删除一个临时文件(目录可能尚不存在 → mkdir 该父目录)。
  try {
    await fs.promises.mkdir(candidate, { recursive: true });
    const probe = path.join(candidate, `.cindy-probe-${randomUUID()}`);
    const fh = await fs.promises.open(probe, 'wx', 0o600);
    await fh.close();
    await fs.promises.unlink(probe);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'LIBRARY_UNAVAILABLE',
      message: `目录不可写(${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (req.getDiskFreeBytes) {
    let free: number | null = null;
    try {
      free = await req.getDiskFreeBytes(candidate);
    } catch {
      free = null;
    }
    if (free !== null && free < 256 * 1024 * 1024) {
      return { ok: false, errorCode: 'DISK_FULL', message: '目标磁盘剩余空间不足(至少 256 MiB)' };
    }
  }
  return { ok: true, libraryRoot, warnings };
}

/**
 * LibraryBindingStore — owner-scoped binding 文件的读写与漂移解析。
 * 文件损坏 → 按无自定义 binding 处理(全部回落系统默认根)+ warn:插件保持
 * 可用,用户自定义位置上的数据本体不动,重新绑定即可找回——比 fail closed
 * 到全部不可用更符合「恢复的是配置,不是授权」的兜底语义。
 */
export class LibraryBindingStore {
  constructor(private readonly deps: LibraryBindingDeps) {}

  private get now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private async readData(): Promise<LibraryBindingFileData> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.deps.getFile(), 'utf8')) as LibraryBindingFileData;
      if (typeof raw === 'object' && raw !== null && raw.version === 1 && typeof raw.bindings === 'object' && raw.bindings !== null) {
        return raw;
      }
      throw new Error('malformed');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.log?.warn('library binding file unreadable; falling back to default roots', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { version: 1, bindings: {} };
    }
  }

  /** 原子写(tmp+rename;损坏不放大)。 */
  private async writeData(data: LibraryBindingFileData): Promise<void> {
    const file = this.deps.getFile();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.promises.rename(tmp, file);
  }

  /**
   * 绑定(裁决后调用):先校验候选位置,再记录 realpath 快照 + identity +
   * generation。已存在 binding 时视为重新绑定,generation 递增。
   */
  async setBinding(
    ghostId: string,
    candidate: string,
    getDiskFreeBytes?: (root: string) => Promise<number | null>,
  ): Promise<{ ok: true; record: LibraryBindingRecord; warnings: string[] } | LocationValidationFailure> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(ghostId)) {
      return { ok: false, errorCode: 'PATH_INVALID', message: 'ghostId 非法' };
    }
    const validation = await validateLibraryCandidateLocation({ candidate, ghostId, deps: this.deps, getDiskFreeBytes });
    if (!validation.ok) return validation;
    let realRoot: string;
    let identity: { dev: number; ino: number } | null = null;
    try {
      realRoot = await fs.promises.realpath(candidate);
      const st = await fs.promises.stat(realRoot);
      identity = { dev: st.dev, ino: st.ino };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'LIBRARY_UNAVAILABLE',
        message: `无法确认目录身份(${err instanceof Error ? err.message : String(err)})`,
      };
    }
    const data = await this.readData();
    const prev = data.bindings[ghostId];
    const record: LibraryBindingRecord = {
      root: candidate,
      realPathAtGrant: realRoot,
      identity,
      grantedAt: this.now,
      generation: (prev?.generation ?? 0) + 1,
    };
    data.bindings[ghostId] = record;
    await this.writeData(data);
    this.deps.log?.info('library binding set', { ghostId, generation: record.generation });
    return { ok: true, record, warnings: validation.warnings };
  }

  /** 撤销授权:删除 binding(数据本体不动;迁回默认走迁移状态机)。 */
  async removeBinding(ghostId: string): Promise<void> {
    const data = await this.readData();
    if (!(ghostId in data.bindings)) return;
    delete data.bindings[ghostId];
    await this.writeData(data);
    this.deps.log?.info('library binding removed', { ghostId });
  }

  getBinding(ghostId: string): Promise<LibraryBindingRecord | null> {
    return this.readData().then((d) => d.bindings[ghostId] ?? null);
  }

  /**
   * 解析库根:无 binding → 系统默认;有 binding → 漂移检测(realpath 重解 +
   * identity 比对)。漂移时返回 root:null,上层必须进入 unavailable 状态并
   * 引导重新确认,**绝不静默跟随、绝不当空库**。
   */
  async resolveLibraryRoot(ghostId: string): Promise<LibraryLocationResolution> {
    const record = await this.getBinding(ghostId);
    if (!record) return { kind: 'default', root: this.deps.getDefaultRoot(ghostId) };
    let realRoot: string;
    let st: fs.Stats;
    try {
      realRoot = await fs.promises.realpath(record.root);
      st = await fs.promises.stat(realRoot);
    } catch {
      return { kind: 'custom', root: null, drift: 'disk-missing', record };
    }
    if (realRoot !== record.realPathAtGrant) {
      return { kind: 'custom', root: null, drift: 'binding-moved', record };
    }
    if (
      record.identity !== null &&
      record.identity.ino !== 0 &&
      (st.dev !== record.identity.dev || st.ino !== record.identity.ino)
    ) {
      // 同路径但对象已换(删后重建):POSIX 可检出;Windows ino=0 时上方已跳过。
      return { kind: 'custom', root: null, drift: 'binding-moved', record };
    }
    return { kind: 'custom', root: path.join(realRoot, ghostId), record };
  }
}
