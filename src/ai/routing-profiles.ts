// Phase 10: smart model routing over the existing AI Router.
// Profiles select a deterministic routing strategy without changing ModelProvider;
// they only rewrite `model`, which the router resolves exactly as before.

export type RoutingProfile = 'FAST' | 'DEFAULT' | 'COMPLEX' | 'RESEARCH';

export const ROUTING_PROFILES: readonly RoutingProfile[] = ['FAST', 'DEFAULT', 'COMPLEX', 'RESEARCH'];

export function isRoutingProfile(value: unknown): value is RoutingProfile {
  return value === 'FAST' || value === 'DEFAULT' || value === 'COMPLEX' || value === 'RESEARCH';
}

/** Display metadata for each profile; safe for Telegram/admin surfaces. */
export const ROUTING_PROFILE_INFO: Readonly<Record<RoutingProfile, { label: string; description: string }>> = {
  FAST: { label: '⚡ Fast', description: 'Cheapest enabled provider; short answers' },
  DEFAULT: { label: '🤖 Default', description: 'Highest-weight enabled provider' },
  COMPLEX: { label: '🧠 Complex', description: 'Deterministic strongest provider; longer budget' },
  RESEARCH: { label: '🔍 Research', description: 'Strongest provider with web tools enabled' },
};

export interface RoutingProfileInputs {
  /** Exact model reference from the request (may be an explicit provider:model or a bare model id). */
  model: string;
  /** Exact directory snapshots the router would otherwise consult. */
  providers: ReadonlyArray<{ id: string; enabled: boolean; weight: number }>;
}

/** Result of profile resolution. Everything stays provider-agnostic. */
export interface ResolvedRouting {
  profile: RoutingProfile;
  /** Model string handed to AIRouter.generate — resolved with identical semantics. */
  model: string;
  /** Output token budget multiplier applied by the caller (1 = unchanged). */
  outputMultiplier: 1 | 2;
  /** Whether the caller should enable the web_search/web_fetch tool loop. */
  enableWebTools: boolean;
}

/**
 * Resolves a routing profile deterministically:
 * - Unrecognized/empty profile names fall back to DEFAULT (never throw).
 * - Explicit provider selections ("id:model", including "id:") are preserved
 *   verbatim: the profile only supplies output budget and web-tool policy.
 * - Bare model ids under named profiles: FAST pins the lowest-weight enabled
 *   provider (cheapest-by-convention), COMPLEX pins the highest-weight
 *   enabled provider ("strongest-by-convention"); weights tie-break by id.
 * - DEFAULT returns everything unchanged (the router's own ordering applies).
 * - Provider ids must already be valid ([a-z0-9-]); unparseable references
 *   yield to the router unchanged so its own validation decides.
 */
export function resolveRoutingProfile(profile: unknown, inputs: RoutingProfileInputs): ResolvedRouting {
  const normalized: RoutingProfile = isRoutingProfile(profile) ? profile : 'DEFAULT';
  const requested = inputs.model;
  if (normalized === 'DEFAULT' || normalized === 'RESEARCH') {
    const outputMultiplier = normalized === 'RESEARCH' ? 2 : 1;
    const enableWebTools = normalized === 'RESEARCH';
    // productionFlow passes the bare sentinel "router" for normal chat. The
    // router's bare-model path would otherwise send the literal string
    // "router" as the vendor model (upstream 400 model-not-found). Translate
    // the sentinel to the highest-weight enabled provider with an EMPTY model
    // part, so the router resolves that provider's default_model. Only the
    // exact sentinel is translated: any other bare model id keeps the
    // documented "bare vendor model on the highest-weight provider" behavior,
    // and explicit "id:model" / "id:" references are untouched.
    if (requested === 'router') {
      const enabled = [...inputs.providers]
        .filter((entry) => entry.enabled)
        .sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const pick = enabled[0];
      if (pick !== undefined) {
        return { profile: normalized, model: `${pick.id}:`, outputMultiplier, enableWebTools };
      }
      // No enabled provider: leave unchanged — the router then fails with its
      // existing generic 'unavailable' semantics.
    }
    return { profile: normalized, model: requested, outputMultiplier, enableWebTools };
  }
  const separator = requested.indexOf(':');
  if (separator > 0 && /^[a-z0-9-]+$/.test(requested.slice(0, separator))) {
    return { profile: normalized, model: requested, outputMultiplier: 1, enableWebTools: false };
  }
  const enabled = [...inputs.providers].filter((entry) => entry.enabled).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (enabled.length === 0) {
    return { profile: normalized, model: requested, outputMultiplier: normalized === 'COMPLEX' ? 2 : 1, enableWebTools: false };
  }
  const pick = normalized === 'FAST' ? (enabled[enabled.length - 1] as { id: string }) : (enabled[0] as { id: string });
  return { profile: normalized, model: `${pick.id}:${requested}`, outputMultiplier: normalized === 'COMPLEX' ? 2 : 1, enableWebTools: false };
}

/**
 * Research-mode tool policy: only the read-only web tools may be exposed to
 * research requests. Unknown, provider-specific, or mutating tools are
 * filtered out; the allowlist is explicit, not inferred.
 */
export const RESEARCH_TOOL_ALLOWLIST: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

export function researchToolNames(registered: readonly string[]): string[] {
  return registered.filter((name) => RESEARCH_TOOL_ALLOWLIST.has(name)).slice(0, 8);
}
