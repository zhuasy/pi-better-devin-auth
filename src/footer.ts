/**
 * Single-line colored footer component for Pi when a Devin model is active.
 *
 * Combines session token stats, context window usage, Devin remaining quota,
 * and model / thinking level onto a single stats row (below the pwd/branch
 * header line), coloring each metric individually and gracefully compacting
 * when the terminal is narrow.
 */

import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { DevinQuota } from './cloud-direct/index.js';
import {
  formatModelRight,
  formatStatsLeft,
  type FooterRightMeta,
  type SessionFooterStats,
  type StatusTheme,
} from './quota-format.js';

function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === '' ? '~' : `~${sep}${rel}`;
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim();
}

function collectSessionStats(ctx: ExtensionContext, isDevinProvider: boolean): SessionFooterStats {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let latestCacheHitRate: number | undefined;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
    const msg = entry.message as AssistantMessage;
    const u = msg.usage;
    if (!u) continue;
    input += u.input ?? 0;
    output += u.output ?? 0;
    cacheRead += u.cacheRead ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    cost += u.cost?.total ?? 0;

    const promptTotal = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (promptTotal > 0 && ((u.cacheRead ?? 0) > 0 || (u.cacheWrite ?? 0) > 0)) {
      latestCacheHitRate = ((u.cacheRead ?? 0) / promptTotal) * 100;
    }
  }

  const contextUsage = ctx.getContextUsage();
  const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercent = contextUsage?.percent ?? null;

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    latestCacheHitRate,
    contextPercent,
    contextWindow,
    usingSubscription: isDevinProvider,
  };
}

/**
 * Install the colored single-line footer on `ctx.ui`. Returns a trigger
 * function the extension can call whenever fresh quota data arrives.
 */
export function installDevinFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getQuota: () => DevinQuota | undefined,
  providerId: string,
): { requestRender: () => void } {
  let rerender: (() => void) | undefined;

  ctx.ui.setFooter((tui, theme, footerData) => {
    rerender = () => tui.requestRender();
    const unsub = footerData.onBranchChange(() => tui.requestRender());
    const statusTheme = theme as unknown as StatusTheme;

    return {
      dispose() {
        unsub();
        rerender = undefined;
      },
      invalidate() {},
      render(width: number): string[] {
        const isDevin = ctx.model?.provider === providerId;
        const quota = isDevin ? getQuota() : undefined;

        const ellipsis = statusTheme.fg('dim', '...');
        const minPadding = 2;
        const alignRow = (leftText: string, rightText: string): string => {
          if (!rightText) return truncateToWidth(leftText, width, ellipsis);
          const lW = visibleWidth(leftText);
          const rW = visibleWidth(rightText);
          if (lW + minPadding + rW <= width) {
            return leftText + ' '.repeat(width - lW - rW) + rightText;
          }
          const availRight = width - lW - minPadding;
          if (availRight > 0) {
            const truncRight = truncateToWidth(rightText, availRight, '');
            const pad = ' '.repeat(Math.max(0, width - lW - visibleWidth(truncRight)));
            return leftText + pad + truncRight;
          }
          return truncateToWidth(leftText, width, ellipsis);
        };

        const extStatuses = footerData.getExtensionStatuses();
        const optchatCompact = sanitizeStatus(extStatuses.get('optchat-compact') ?? '');

        // Model/thinking segment
        const thinkingLevel = ctx.model?.reasoning ? pi.getThinkingLevel() : undefined;
        const showProvider = footerData.getAvailableProviderCount() > 1 && Boolean(ctx.model);
        const rightMeta: FooterRightMeta = {
          provider: ctx.model?.provider,
          modelId: ctx.model?.id || 'no-model',
          thinkingLevel,
          showProvider,
        };
        let modelRight = formatModelRight(rightMeta, statusTheme);

        // Line 1: cwd + git branch + session name | (when optchat-compact present) model/thinking on right
        const branch = footerData.getGitBranch();
        const sessionName = ctx.sessionManager.getSessionName();
        const headerParts = [statusTheme.fg('muted', formatCwd(ctx.cwd))];
        if (branch) headerParts.push(statusTheme.fg('syntaxKeyword', `(${branch})`));
        if (sessionName) {
          headerParts.push(statusTheme.fg('dim', '•'));
          headerParts.push(statusTheme.fg('accent', sessionName));
        }
        const pwdLeft = headerParts.join(' ');
        if (optchatCompact && showProvider && visibleWidth(pwdLeft) + minPadding + visibleWidth(modelRight) > width) {
          modelRight = formatModelRight({ ...rightMeta, showProvider: false }, statusTheme);
        }
        const pwdLine = optchatCompact
          ? alignRow(pwdLeft, modelRight)
          : truncateToWidth(pwdLeft, width, ellipsis);

        // Line 2: token stats + Devin quota | optchat-compact (or model/thinking when no optchat-compact)
        const stats = collectSessionStats(ctx, isDevin);
        let left = formatStatsLeft(stats, quota, statusTheme, Date.now(), false);
        let right = optchatCompact || modelRight;

        // If full quota + right side don't fit on one line, switch to compact quota
        if (quota && visibleWidth(left) + minPadding + visibleWidth(right) > width) {
          left = formatStatsLeft(stats, quota, statusTheme, Date.now(), true);
        }
        // If still tight and model is on row 2, drop the provider prefix
        if (!optchatCompact && showProvider && visibleWidth(left) + minPadding + visibleWidth(right) > width) {
          right = formatModelRight({ ...rightMeta, showProvider: false }, statusTheme);
        }

        const statsLine = alignRow(left, right);
        const lines = [pwdLine, statsLine];

        // Preserve other extensions' setStatus() entries (suppress pi-optchat's verbose 'optchat' when compact is active)
        if (extStatuses.size > 0) {
          const joined = Array.from(extStatuses.entries())
            .filter(([k]) => k !== 'optchat-compact' && !(optchatCompact && (k === 'optchat' || k === 'optchat.role')))
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([, text]) => sanitizeStatus(text))
            .filter(Boolean)
            .join(' ');
          if (joined) lines.push(truncateToWidth(joined, width, ellipsis));
        }

        return lines;
      },
    };
  });

  return {
    requestRender: () => rerender?.(),
  };
}
