// Prompt-section contributors: installed modules append sections to the
// destinations prompt based on what's wired — e.g. a chat channel's module
// adds a file-delivery hint when a channel destination is present. Inert when
// nothing registers; a throwing contributor is skipped.
import type { DestinationEntry } from '../destinations.js';

type PromptSectionContributor = (destinations: DestinationEntry[]) => string | null;
const promptSectionContributors: PromptSectionContributor[] = [];
export function registerPromptSectionContributor(fn: PromptSectionContributor): void {
  promptSectionContributors.push(fn);
}
export function resolvePromptSections(destinations: DestinationEntry[]): string[] {
  const sections: string[] = [];
  for (const fn of promptSectionContributors) {
    try {
      const s = fn(destinations);
      if (s) sections.push(s);
    } catch {
      // A contributor bug must never break prompt composition.
    }
  }
  return sections;
}
