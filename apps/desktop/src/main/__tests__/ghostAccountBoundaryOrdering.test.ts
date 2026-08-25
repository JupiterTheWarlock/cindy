import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('Ghost account-boundary teardown ordering', () => {
  const bootstrap = readFileSync(resolve(__dirname, '../bootstrap-electron.ts'), 'utf8').replace(
    /\r\n?/g,
    '\n',
  );
  const ghostIndex = readFileSync(resolve(__dirname, '../cindy-brain/index.ts'), 'utf8').replace(
    /\r\n?/g,
    '\n',
  );
  const authManager = readFileSync(resolve(__dirname, '../authManager.ts'), 'utf8').replace(
    /\r\n?/g,
    '\n',
  );

  it('destroys owner-scoped panel windows before draining plugin work', () => {
    const start = bootstrap.indexOf(
      'async function teardownGhostProjectionBoundary(reason: string): Promise<void> {',
    );
    const end = bootstrap.indexOf('\n}\n', start);
    const body = bootstrap.slice(start, end);

    const resetPanelWindows = body.indexOf('ghostPanelWindowsController.destroyForOwnerBoundary();');
    const interrupt = body.indexOf('interruptGhostCallsForAccountBoundary));');
    const wait = body.indexOf('waitForGhostMutations));');
    const suspend = body.indexOf('suspendAllGhosts);');

    expect(resetPanelWindows).toBeGreaterThan(-1);
    expect(resetPanelWindows).toBeLessThan(interrupt);
    expect(interrupt).toBeGreaterThan(-1);
    expect(interrupt).toBeLessThan(wait);
    expect(wait).toBeLessThan(suspend);
  });

  it('replaces the terminal Node broker after an owner boundary', () => {
    const helperStart = ghostIndex.indexOf(
      'function resetNodeRuntimeBrokerForAccountBoundary(): void {',
    );
    const helperEnd = ghostIndex.indexOf('\n}', helperStart);
    const helper = ghostIndex.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThan(-1);
    expect(helper).toContain('broker.destroyAll();');
    expect(helper).toContain('nodeRuntimeBrokerSingleton = null;');
    expect(ghostIndex).toContain('resetNodeRuntimeBrokerForAccountBoundary();');
  });

  it('aborts admitted WebView requests and destroys their producers before draining', () => {
    const start = ghostIndex.indexOf(
      'export async function interruptGhostCallsForAccountBoundary(): Promise<void> {',
    );
    const end = ghostIndex.indexOf('\n}', start);
    const body = ghostIndex.slice(start, end);

    const abortExternalLink = body.indexOf(
      'abortGhostExternalLinkNavigationsForAccountBoundary();',
    );
    const abortProtocol = body.indexOf('abortGhostProtocolRequestsForAccountBoundary();');
    const drainProtocol = body.indexOf('await waitForGhostProtocolRequests();');
    const destroyRuntime = body.indexOf('runtimeSingleton?.destroyAll();');
    expect(abortExternalLink).toBeGreaterThan(-1);
    expect(abortExternalLink).toBeLessThan(abortProtocol);
    expect(abortProtocol).toBeGreaterThan(-1);
    expect(abortProtocol).toBeLessThan(destroyRuntime);
    expect(drainProtocol).toBeGreaterThan(-1);
    expect(destroyRuntime).toBeLessThan(drainProtocol);
  });

  it('restores detached windows after the whole owner boundary settles, including prepareCommit failure', () => {
    const cloudStart = authManager.indexOf('async function withCloudOwnerCommit');
    const cloudEnd = authManager.indexOf('\n}\n\n/**', cloudStart);
    const cloudBody = authManager.slice(cloudStart, cloudEnd);
    const accountFreeStart = authManager.indexOf('async function withAccountFreeOwnerCommit');
    const accountFreeEnd = authManager.indexOf('\n}\n\nasync function recoverAccountFreeOwnerAtStartup', accountFreeStart);
    const accountFreeBody = authManager.slice(accountFreeStart, accountFreeEnd);

    for (const body of [cloudBody, accountFreeBody]) {
      const finallyStart = body.lastIndexOf('} finally {');
      const release = body.indexOf('release?.();', finallyStart);
      const settled = body.indexOf('scheduleOwnerBoundarySettledTask();', finallyStart);
      expect(finallyStart).toBeGreaterThan(-1);
      expect(release).toBeGreaterThan(finallyStart);
      expect(settled).toBeGreaterThan(release);
    }
    expect(bootstrap).toContain('authManager.setOwnerBoundarySettledTask(() => {');
    expect(bootstrap).toContain('ghostPanelWindowsController.restoreOpenWindowsForCurrentOwner();');
  });
});
