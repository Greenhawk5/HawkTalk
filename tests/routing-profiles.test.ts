import { describe, expect, it } from 'vitest';
import {
  isRoutingProfile,
  resolveRoutingProfile,
  researchToolNames,
  ROUTING_PROFILE_INFO,
  ROUTING_PROFILES,
} from '../src/ai/routing-profiles';

describe('routing profiles', () => {
  it('recognizes the four approved profiles and falls back for junk', () => {
    expect(ROUTING_PROFILES).toEqual(['FAST', 'DEFAULT', 'COMPLEX', 'RESEARCH']);
    expect(isRoutingProfile('FAST')).toBe(true);
    expect(isRoutingProfile('fast')).toBe(false);
    expect(isRoutingProfile('')).toBe(false);
    expect(isRoutingProfile(null)).toBe(false);
    for (const profile of ROUTING_PROFILES) {
      expect(ROUTING_PROFILE_INFO[profile].label.length).toBeGreaterThan(0);
      expect(ROUTING_PROFILE_INFO[profile].description.length).toBeGreaterThan(0);
    }
  });

  it('translates the bare sentinel "router" to the highest-weight enabled provider under DEFAULT', () => {
    const providers = [
      { id: 'b', enabled: true, weight: 10 },
      { id: 'a', enabled: true, weight: 90 },
    ];
    expect(resolveRoutingProfile('DEFAULT', { model: 'router', providers })).toEqual({
      profile: 'DEFAULT', model: 'a:', outputMultiplier: 1, enableWebTools: false,
    });
  });

  it('keeps non-sentinel DEFAULT semantics exactly: model, budget, and tools unchanged', () => {
    const providers = [{ id: 'b', enabled: true, weight: 10 }];
    expect(resolveRoutingProfile('DEFAULT', { model: 'vendor-m', providers })).toEqual({
      profile: 'DEFAULT', model: 'vendor-m', outputMultiplier: 1, enableWebTools: false,
    });
    // Explicit selections stay verbatim under DEFAULT too.
    expect(resolveRoutingProfile('DEFAULT', { model: 'b:custom', providers }).model).toBe('b:custom');
    expect(resolveRoutingProfile('DEFAULT', { model: 'b:', providers }).model).toBe('b:');
  });

  it('degrades junk profiles to DEFAULT, which still translates the sentinel', () => {
    const providers = [{ id: 'b', enabled: true, weight: 10 }];
    expect(resolveRoutingProfile('TURBO', { model: 'router', providers }).profile).toBe('DEFAULT');
    expect(resolveRoutingProfile('TURBO', { model: 'router', providers }).model).toBe('b:');
    expect(resolveRoutingProfile(undefined, { model: 'router', providers }).model).toBe('b:');
  });

  it('preserves explicit provider selections verbatim under FAST/COMPLEX', () => {
    const providers = [{ id: 'a', enabled: true, weight: 1 }, { id: 'b', enabled: true, weight: 10 }];
    expect(resolveRoutingProfile('FAST', { model: 'a:custom', providers }).model).toBe('a:custom');
    expect(resolveRoutingProfile('COMPLEX', { model: 'b:', providers }).model).toBe('b:');
  });

  it('pins bare model ids deterministically: FAST lowest weight, COMPLEX highest', () => {
    const providers = [
      { id: 'cheap', enabled: true, weight: 1 },
      { id: 'strong', enabled: true, weight: 50 },
      { id: 'mid', enabled: true, weight: 10 },
    ];
    expect(resolveRoutingProfile('FAST', { model: 'router', providers }).model).toBe('cheap:router');
    const complex = resolveRoutingProfile('COMPLEX', { model: 'router', providers });
    expect(complex.model).toBe('strong:router');
    expect(complex.outputMultiplier).toBe(2);
    // Disabled providers never win; weight ties break by id.
    const tied = [{ id: 'zed', enabled: true, weight: 5 }, { id: 'abc', enabled: true, weight: 5 }];
    expect(resolveRoutingProfile('FAST', { model: 'router', providers: tied }).model).toBe('zed:router');
    expect(resolveRoutingProfile('COMPLEX', { model: 'router', providers: tied }).model).toBe('abc:router');
  });

  it('degrades to router semantics when no providers are enabled', () => {
    const disabled = [{ id: 'a', enabled: false, weight: 1 }];
    expect(resolveRoutingProfile('FAST', { model: 'router', providers: disabled }).model).toBe('router');
    expect(resolveRoutingProfile('COMPLEX', { model: 'router', providers: [] }).model).toBe('router');
  });

  it('gives RESEARCH double budget plus web tools, with the sentinel translated', () => {
    const providers = [{ id: 'b', enabled: true, weight: 10 }];
    expect(resolveRoutingProfile('RESEARCH', { model: 'router', providers })).toEqual({
      profile: 'RESEARCH', model: 'b:', outputMultiplier: 2, enableWebTools: true,
    });
  });

  it('leaves the sentinel unchanged when no enabled provider exists (existing router error semantics)', () => {
    const disabled = [{ id: 'a', enabled: false, weight: 1 }];
    expect(resolveRoutingProfile('DEFAULT', { model: 'router', providers: disabled }).model).toBe('router');
    expect(resolveRoutingProfile('RESEARCH', { model: 'router', providers: [] }).model).toBe('router');
  });

  it('restricts research tools to the read-only web allowlist', () => {
    expect(researchToolNames(['web_search', 'web_fetch', 'exec_shell', 'delete_user', 'unknown'])).toEqual(['web_search', 'web_fetch']);
    expect(researchToolNames([])).toEqual([]);
  });
});