// Prompt-section contributors: installed modules append sections to the
// destinations prompt based on what's wired — e.g. a chat channel's module
// adds a file-delivery hint when a channel destination is present. The
// capabilities argument lets a contributor stay silent about a tool the
// provider has no client for. Inert when nothing registers; a throwing
// contributor is skipped.
import type { DestinationEntry } from '../destinations.js';

/**
 * What the provider can actually do, so a contributor can stay silent about a
 * tool the model has no client for. Declared HERE rather than imported: the
 * seam must not depend on a type an installed module adds, and structural
 * typing makes a module's own equivalent shape compatible.
 */
export interface PromptCapabilities {
  /** True when NanoClaw's MCP tools are callable by the model. Absent = no. */
  mcpTools?: boolean;
}

type PromptSectionContributor = (destinations: DestinationEntry[], capabilities: PromptCapabilities) => string | null;
const promptSectionContributors: PromptSectionContributor[] = [];
export function registerPromptSectionContributor(fn: PromptSectionContributor): void {
  promptSectionContributors.push(fn);
}
export function resolvePromptSections(
  destinations: DestinationEntry[],
  capabilities: PromptCapabilities = {},
): string[] {
  const sections: string[] = [];
  for (const fn of promptSectionContributors) {
    try {
      const s = fn(destinations, capabilities);
      if (s) sections.push(s);
    } catch {
      // A contributor bug must never break prompt composition.
    }
  }
  return sections;
}
