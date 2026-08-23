import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildLinuxUpdateScript,
  shellSingleQuote,
  DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS,
  type LinuxUpdateScriptParams,
} from '../updateScriptLinux';

const STAGED_SHA = 'a'.repeat(64);

function makeParams(overrides: Partial<LinuxUpdateScriptParams> = {}): LinuxUpdateScriptParams {
  return {
    pid: 12345,
    debPath: '/tmp/cindy-0.0.2-amd64.deb',
    sha256: STAGED_SHA,
    exePath: '/usr/lib/cindy/Cindy',
    lockFilePath: '/tmp/cindy-update.lock',
    logPath: '/tmp/cindy-update.log',
    ...overrides,
  };
}

describe('shellSingleQuote', () => {
  it('wraps paths in single quotes and escapes embedded quotes', () => {
    expect(shellSingleQuote(`/tmp/cindy's.deb`)).toBe(`'/tmp/cindy'\\''s.deb'`);
    expect(shellSingleQuote('/usr/lib/cindy/Cindy')).toBe(`'/usr/lib/cindy/Cindy'`);
  });
});

describe('buildLinuxUpdateScript structure', () => {
  const script = buildLinuxUpdateScript(makeParams());

  it('installs the staged .deb through one pkexec bash shell', () => {
    expect(script).toContain('PKEXEC=/usr/bin/pkexec');
    expect(script).toContain('ELEVATED=\'set -eu');
    expect(script).toContain('"$PKEXEC" /bin/bash -c "$ELEVATED"');
    expect(script).toContain('apt-get install --yes --allow-downgrades');
    expect(script).toContain('dpkg --install');
    expect(script).toContain(`'/tmp/cindy-0.0.2-amd64.deb'`);
  });

  it('passes the manifest sha256 and deb path as argv to the elevated shell', () => {
    expect(script).toContain(
      `"$PKEXEC" /bin/bash -c "$ELEVATED" bash '${STAGED_SHA}' '/tmp/cindy-0.0.2-amd64.deb'`,
    );
  });

  it('never hands the user-replaceable log path to the elevated root shell', () => {
    // 只取 ELEVATED 提权段本体(到结束引号为止),外层用户 shell 的重定向不在此列。
    const elevated = script.slice(script.indexOf('ELEVATED='), script.indexOf("fi'", script.indexOf('ELEVATED=')) + 3);
    expect(elevated).not.toContain('cindy-update.log');
    // 日志重定向由外层用户 shell 完成,提权进程只写 stdout/stderr。
    expect(script).toContain(
      `"$PKEXEC" /bin/bash -c "$ELEVATED" bash '${STAGED_SHA}' '/tmp/cindy-0.0.2-amd64.deb' >> '/tmp/cindy-update.log' 2>&1`,
    );
  });

  it('copies the .deb to a root-owned 0700 temp dir and hashes before installing', () => {
    const elevated = script.slice(script.indexOf('ELEVATED='), script.indexOf('"$PKEXEC" /bin/bash'));
    const copyIdx = elevated.indexOf('cat <&3 > "$TMP/update.deb"');
    const hashIdx = elevated.indexOf('if [ "$ACTUAL" != "$1" ]');
    const aptIdx = elevated.indexOf('apt-get install');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeGreaterThan(copyIdx);
    expect(aptIdx).toBeGreaterThan(hashIdx);
    expect(elevated).toContain('TMP=$(mktemp -d "${TMPDIR:-/tmp}/cindy-deb.XXXXXX")');
    expect(elevated).toContain('chmod 700 "$TMP"');
  });

  it('rejects symlinks and non-regular staged sources at the elevated boundary', () => {
    const elevated = script.slice(script.indexOf('ELEVATED='), script.indexOf('"$PKEXEC" /bin/bash'));
    expect(elevated).toContain('if [ -L "$2" ] || [ ! -f "$2" ]; then');
    expect(elevated).toContain('if ! [ -f /proc/self/fd/3 ]; then');
    expect(elevated).toContain('echo "staged package is not a regular file" >&2');
  });

  it('does not run dpkg/apt outside the elevated pkexec shell', () => {
    const outside = script.slice(script.indexOf('ELEVATED='));
    // 除 ELEVATED 内的安装器,外层脚本里只允许 pkexec /bin/bash 一条特权调用。
    const pkexecCalls = outside.match(/"\$PKEXEC"/g) ?? [];
    expect(pkexecCalls).toHaveLength(1);
    expect(outside).toContain('"$PKEXEC" /bin/bash -c "$ELEVATED"');
  });

  it('keeps the update lock alive and writes the updater pid into it', () => {
    const lockIdx = script.indexOf(`echo updating $$ > '/tmp/cindy-update.lock'`);
    const pkexecIdx = script.indexOf('"$PKEXEC" /bin/bash');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(pkexecIdx).toBeGreaterThan(lockIdx);
    // 锁内容带 $$(updater shell 自己的 PID),bootstrap 据此判定持有者是否存活。
    const heartbeatLines = script.split('\n').filter((l) => l.includes('echo updating $$'));
    expect(heartbeatLines.length).toBeGreaterThanOrEqual(2);
    expect(script).toContain('LOCK_HEARTBEAT_PID=$!');
    expect(script).toContain('trap cleanup EXIT');
    expect(script).toContain("rm -f '/tmp/cindy-update.lock'");
  });

  it('rejects a missing or malformed sha256 instead of installing unverified bytes', () => {
    expect(() => buildLinuxUpdateScript(makeParams({ sha256: 'abc' }))).toThrow(/sha256/);
  });

  it('escalates SIGKILL at exitKillAfterSeconds and aborts at exitAbortAfterSeconds', () => {
    const t = DEFAULT_LINUX_UPDATE_SCRIPT_TIMINGS;
    const killIdx = script.indexOf(`-eq ${t.exitKillAfterSeconds} `);
    const abortIdx = script.indexOf(`-ge ${t.exitAbortAfterSeconds} `);
    expect(killIdx).toBeGreaterThan(-1);
    expect(abortIdx).toBeGreaterThan(killIdx);
    const abortBlock = script.slice(abortIdx, script.indexOf('done', abortIdx));
    expect(abortBlock).toContain('exit 1');
    expect(script.slice(killIdx, abortIdx)).toContain('kill -9 12345');
  });

  it('relaunches the previous binary if install fails', () => {
    expect(script).toContain('INSTALL FAILED — relaunching previous binary');
    expect(script).toContain(`nohup '/usr/lib/cindy/Cindy' >/dev/null 2>&1 &`);
  });

  it('verifies relaunch by exact process name, not by full command line', () => {
    // pgrep -x 只按进程名匹配,updater 自己的 bash 命令行里含 exePath 也不会误判。
    expect(script).toContain(`pgrep -x 'Cindy'`);
    expect(script).not.toContain('pgrep -f');
  });

  it.runIf(process.platform !== 'win32')('renders to valid bash (bash -n)', () => {
    const tmp = path.join(os.tmpdir(), `cindy-linux-script-syntax-${process.pid}.sh`);
    fs.writeFileSync(tmp, script, { mode: 0o755 });
    try {
      execFileSync('/bin/bash', ['-n', tmp]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});
