/**
 * updateScriptLinux — pure builder for the Linux .deb update-apply bash script.
 *
 * Linux has no cindy-updater binary. After the Electron process exits, this
 * script asks polkit (pkexec) to install the staged .deb over the existing
 * package, then relaunches the same executable path.
 *
 * Extracted so the generated script can be regression-tested without Electron.
 */

export interface LinuxUpdateScriptTimings {
  /** Seconds to wait for the old PID before escalating to SIGKILL. */
  exitKillAfterSeconds: number;
  /** Seconds after which a PID that survived SIGKILL aborts the update. */
  exitAbortAfterSeconds: number;
  /** Total seconds to poll for the relaunched main process. */
  verifyTimeoutSeconds: number;
  /** Second at which relaunch is retried (only if the first launch failed). */
  verifyRetryAtSeconds: number;
  /** Seconds between lock-file heartbeats while pkexec may be waiting. */
  lockHeartbeatSeconds: number;
}

export const DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS: LinuxUpdateScriptTimings = {
  exitKillAfterSeconds: 120,
  exitAbortAfterSeconds: 135,
  verifyTimeoutSeconds: 30,
  verifyRetryAtSeconds: 15,
  lockHeartbeatSeconds: 5,
};

export interface LinuxUpdateScriptParams {
  /** PID of the exiting app process the script must wait for. */
  pid: number;
  /** Absolute path of the downloaded .deb. */
  debPath: string;
  /** Manifest SHA-256 of the staged .deb, rechecked immediately before pkexec. */
  sha256: string;
  /** Absolute path of the installed main binary to relaunch. */
  exePath: string;
  /** Update lock file the bootstrap spins on during the swap. */
  lockFilePath: string;
  /** cindy-update.log path. */
  logPath: string;
  timings?: Partial<LinuxUpdateScriptTimings>;
}

/** POSIX single-quote so paths cannot break out of the generated script. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * pgrep -f treats its pattern as an ERE — escape metacharacters so the
 * installed binary path matches literally.
 */
export function escapeEre(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 进程验证用 `pgrep -x <进程名>` 而不是 `pgrep -f <路径>`:脚本经
 * `bash -c` 在内存里跑,完整命令行里包含 exePath,`-f` 会匹配到
 * updater 自己,把「应用没起来」误判成「已起来」。
 */
export function normalizeLinuxProcName(exePath: string): string | null {
  const base = exePath.split('/').pop() ?? '';
  return /^[A-Za-z0-9._-]{1,15}$/.test(base) ? base : null;
}

export function normalizeLinuxDebSha256(value: string): string | null {
  const hex = value.trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function buildLinuxUpdateScript(params: LinuxUpdateScriptParams): string {
  const { pid, debPath, exePath, lockFilePath, logPath } = params;
  const sha256 = normalizeLinuxDebSha256(params.sha256);
  if (!sha256) {
    throw new Error('Linux update script requires a 64-char sha256 of the staged .deb');
  }
  const t = { ...DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS, ...params.timings };
  const procName = normalizeLinuxProcName(exePath);
  if (!procName) {
    throw new Error('Linux update script requires a verifiable process name from exePath');
  }
  const qLog = shellSingleQuote(logPath);
  const qDeb = shellSingleQuote(debPath);
  const qExe = shellSingleQuote(exePath);
  const qProc = shellSingleQuote(procName);
  const qLock = shellSingleQuote(lockFilePath);
  const qSha = shellSingleQuote(sha256);

  return [
    '#!/bin/bash',
    'set -u',
    `echo "[$(date)] Update script started, waiting for PID ${pid}" >> ${qLog}`,
    `echo "[$(date)] deb=${qDeb} exe=${qExe}" >> ${qLog}`,
    '',
    `echo updating > ${qLock}`,
    '(',
    '    while true; do',
    `        echo updating > ${qLock}`,
    `        sleep ${t.lockHeartbeatSeconds}`,
    '    done',
    ') &',
    'LOCK_HEARTBEAT_PID=$!',
    'cleanup() {',
    '    kill "$LOCK_HEARTBEAT_PID" 2>/dev/null',
    `    rm -f ${qLock}`,
    '}',
    'trap cleanup EXIT',
    '',
    'WAITED=0',
    `while kill -0 ${pid} 2>/dev/null; do`,
    '    sleep 1',
    '    WAITED=$((WAITED+1))',
    `    if [ "$WAITED" -eq ${t.exitKillAfterSeconds} ]; then`,
    `        echo "[$(date)] PID ${pid} still alive after ${t.exitKillAfterSeconds}s — exit appears hung, sending SIGKILL" >> ${qLog}`,
    `        kill -9 ${pid} 2>/dev/null`,
    '    fi',
    `    if [ "$WAITED" -ge ${t.exitAbortAfterSeconds} ]; then`,
    `        echo "[$(date)] FATAL: PID ${pid} survived SIGKILL — aborting update" >> ${qLog}`,
    '        exit 1',
    '    fi',
    'done',
    `echo "[$(date)] Process ${pid} exited, waiting for filesystem to settle" >> ${qLog}`,
    'sleep 2',
    '',
    'PKEXEC=/usr/bin/pkexec',
    'if [ ! -x "$PKEXEC" ]; then',
    '    PKEXEC=$(command -v pkexec 2>/dev/null || true)',
    'fi',
    'if [ -z "$PKEXEC" ] || [ ! -x "$PKEXEC" ]; then',
    `    echo "[$(date)] FATAL: pkexec not found — cannot install .deb" >> ${qLog}`,
    `    nohup ${qExe} >/dev/null 2>&1 &`,
    '    exit 1',
    'fi',
    '',
    `if [ ! -f ${qDeb} ]; then`,
    `    echo "[$(date)] FATAL: staged .deb missing before install" >> ${qLog}`,
    `    nohup ${qExe} >/dev/null 2>&1 &`,
    '    exit 1',
    'fi',
    // 提权边界校验:整个「复制 → 哈希 → 安装」都在同一个 root shell 里完成。
    // .deb 先拷进 root 自有的 0700 临时目录,哈希与安装读的是同一份 root 所有
    // 的副本,用户侧进程无法在哈希后换包;期望摘要与路径经 argv 传入。
    // 提权 shell 只写 stdout/stderr,由外层用户 shell 重定向到日志——
    // root 自己从不打开用户可替换的日志路径(符号链接攻击面)。
    'ELEVATED=\'set -eu',
    'TMP=$(mktemp -d "${TMPDIR:-/tmp}/cindy-deb.XXXXXX")',
    'chmod 700 "$TMP"',
    'cleanup_e() { rm -rf "$TMP"; }',
    'trap cleanup_e EXIT',
    'cp -f -- "$2" "$TMP/update.deb"',
    `ACTUAL=$(sha256sum "$TMP/update.deb" | awk "{print \\$1}")`,
    'if [ "$ACTUAL" != "$1" ]; then',
    '    echo "sha256 mismatch: expected $1 got $ACTUAL" >&2',
    '    exit 1',
    'fi',
    'if [ -x /usr/bin/apt-get ]; then',
    '    apt-get install --yes --allow-downgrades "$TMP/update.deb"',
    'elif [ -x /usr/bin/dpkg ]; then',
    '    dpkg --install "$TMP/update.deb"',
    'else',
    '    exit 127',
    'fi\'',
    '',
    `echo "[$(date)] invoking elevated installer via pkexec" >> ${qLog}`,
    `"$PKEXEC" /bin/bash -c "$ELEVATED" bash ${qSha} ${qDeb} >> ${qLog} 2>&1`,
    'INSTALL_EXIT=$?',
    `echo "[$(date)] install exit code: $INSTALL_EXIT" >> ${qLog}`,
    '',
    'if [ "$INSTALL_EXIT" -ne 0 ]; then',
    `    echo "[$(date)] INSTALL FAILED — relaunching previous binary" >> ${qLog}`,
    `    nohup ${qExe} >/dev/null 2>&1 &`,
    '    exit 1',
    'fi',
    '',
    `echo "[$(date)] Starting app: ${qExe}" >> ${qLog}`,
    `nohup ${qExe} >/dev/null 2>&1 &`,
    'OPEN_EXIT=$?',
    `echo "[$(date)] relaunch spawn exit code: $OPEN_EXIT" >> ${qLog}`,
    '',
    'VERIFIED=0',
    `for i in $(seq 1 ${t.verifyTimeoutSeconds}); do`,
    // pgrep -x 只按进程名精确匹配:updater 自己的 bash 命令行里虽然含
    // exePath,但它的进程名是 bash,不会误判成「应用已起来」。
    `    if [ -x ${qExe} ] && pgrep -x ${qProc} >/dev/null 2>&1; then`,
    '        VERIFIED=1',
    '        break',
    '    fi',
    `    if [ "$i" -eq ${t.verifyRetryAtSeconds} ]; then`,
    `        echo "[$(date)] still not up after ${t.verifyRetryAtSeconds}s — retrying relaunch" >> ${qLog}`,
    `        nohup ${qExe} >/dev/null 2>&1 &`,
    '    fi',
    '    sleep 1',
    'done',
    'if [ "$VERIFIED" -eq 1 ]; then',
    `    echo "[$(date)] PROCESS VERIFIED: main process is running" >> ${qLog}`,
    'else',
    `    echo "[$(date)] WARNING: relaunch not verified within ${t.verifyTimeoutSeconds}s" >> ${qLog}`,
    'fi',
    '',
    `echo "[$(date)] Update script finished" >> ${qLog}`,
  ].join('\n') + '\n';
}
