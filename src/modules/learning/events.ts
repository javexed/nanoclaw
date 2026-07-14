/**
 * Learning-loop events. The learning module stays channel-agnostic: it fires
 * `skillDraftProposed` and each channel decides how to surface it (webchat drops
 * an actionable card into the agent's own room — see channels/webchat/index.ts).
 * Mirrors the approvals module's registerApprovalRequestedListener pattern.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';

export interface SkillDraftProposedEvent {
  draftId: string;
  skillName: string;
  description: string;
  kind: 'create' | 'patch';
  targetSkill: string | null;
  agentGroupId: string;
  agentName: string;
  session: Session;
}

type SkillDraftProposedListener = (e: SkillDraftProposedEvent) => void;
const listeners: SkillDraftProposedListener[] = [];

export function registerSkillDraftProposedListener(cb: SkillDraftProposedListener): void {
  listeners.push(cb);
}

export function notifySkillDraftProposed(e: SkillDraftProposedEvent): void {
  for (const cb of listeners) {
    try {
      cb(e);
    } catch (err) {
      log.error('skillDraftProposed listener threw', { draftId: e.draftId, err });
    }
  }
}

export interface SkillDraftResolvedEvent {
  draftId: string;
  outcome: 'kept' | 'discarded';
  /** Who resolved it — a user id, or 'auto-keep' when the loop accepted it itself. */
  by: string;
}

type SkillDraftResolvedListener = (e: SkillDraftResolvedEvent) => void;
const resolvedListeners: SkillDraftResolvedListener[] = [];

export function registerSkillDraftResolvedListener(cb: SkillDraftResolvedListener): void {
  resolvedListeners.push(cb);
}

export function notifySkillDraftResolved(e: SkillDraftResolvedEvent): void {
  for (const cb of resolvedListeners) {
    try {
      cb(e);
    } catch (err) {
      log.error('skillDraftResolved listener threw', { draftId: e.draftId, err });
    }
  }
}
