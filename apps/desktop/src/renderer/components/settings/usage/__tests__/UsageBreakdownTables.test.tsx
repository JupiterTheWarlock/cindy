// @vitest-environment jsdom

import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UsageAgentTable, UsageModelTable } from '../UsageBreakdownTables';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('UsageBreakdownTables responsive layout', () => {
  it('keeps the agent table wide enough for numeric columns to scroll instead of overlap', () => {
    const { container } = render(
      <div className="overflow-x-auto">
        <UsageAgentTable
          rows={[
            {
              agentKind: 'claude-code',
              tokens: 1_000,
              share: 1,
              todayTokens: 100,
              cacheHitRate: 0.5,
              modelCount: 1,
            },
          ]}
        />
      </div>,
    );

    const scroller = container.querySelector('.overflow-x-auto');
    const table = container.querySelector('table');
    expect(scroller, 'table 必须挂在生产环境的横向滚动容器内').toBeTruthy();
    expect(table?.closest('.overflow-x-auto')).toBe(scroller);
    expect(table?.className).toContain('min-w-[520px]');
    expect(table?.querySelector('tbody td')?.className).toContain('overflow-hidden');
  });

  it('keeps the wider model table scrollable and clips first-column decorations at its boundary', () => {
    const { container } = render(
      <div className="overflow-x-auto">
        <UsageModelTable
          rows={[
            {
              key: 'codex:very-long-model-name',
              agentKind: 'codex',
              model: 'very-long-model-name-that-must-not-overlap-token-columns',
              tokens: 1_000,
              share: 1,
              inputTokens: 400,
              outputTokens: 300,
              cacheReadTokens: 200,
              cacheCreateTokens: 100,
              cacheHitRate: 0.5,
            },
          ]}
        />
      </div>,
    );

    const scroller = container.querySelector('.overflow-x-auto');
    const table = container.querySelector('table');
    expect(scroller, 'table 必须挂在生产环境的横向滚动容器内').toBeTruthy();
    expect(table?.closest('.overflow-x-auto')).toBe(scroller);
    expect(table?.className).toContain('min-w-[720px]');
    expect(table?.querySelector('tbody td')?.className).toContain('overflow-hidden');
  });
});
