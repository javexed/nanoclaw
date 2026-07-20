/**
 * Workspace master switch for the learning loop. When off, auto-learn is
 * disabled everywhere (enforced in materializeContainerJson) and the webchat
 * UI hides the per-agent / per-room learning controls. Owner-set from
 * Settings → Features → Auto-learn. See migration module-learning-master.
 */
import { getDb } from '../../db/connection.js';

export function getLearningMasterEnabled(): boolean {
  try {
    const row = getDb().prepare(`SELECT enabled FROM learning_master WHERE id = 1`).get() as
      | { enabled: number }
      | undefined;
    return row ? row.enabled === 1 : true; // default on when unset
  } catch {
    return true;
  }
}

export function setLearningMasterEnabled(enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO learning_master (id, enabled) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(enabled ? 1 : 0);
}

export interface LearningClassifier {
  /** Roster model id the owner picked (for the Settings UI). */
  modelId: string | null;
  /** Container-reachable call params, resolved at set time. */
  url: string | null;
  model: string | null;
}

export function getLearningClassifier(): LearningClassifier {
  try {
    const row = getDb()
      .prepare(`SELECT classifier_model_id, classifier_url, classifier_model FROM learning_master WHERE id = 1`)
      .get() as { classifier_model_id: string | null; classifier_url: string | null; classifier_model: string | null } | undefined;
    return {
      modelId: row?.classifier_model_id ?? null,
      url: row?.classifier_url ?? null,
      model: row?.classifier_model ?? null,
    };
  } catch {
    return { modelId: null, url: null, model: null };
  }
}

/** Store the picked model id + its resolved container-reachable call params.
 *  Pass all-null to clear (heuristic only). */
export function setLearningClassifier(modelId: string | null, url: string | null, model: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO learning_master (id, enabled, classifier_model_id, classifier_url, classifier_model)
       VALUES (1, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         classifier_model_id = excluded.classifier_model_id,
         classifier_url = excluded.classifier_url,
         classifier_model = excluded.classifier_model`,
    )
    .run(modelId, url, model);
}
