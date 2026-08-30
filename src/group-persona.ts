import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** Per-group standing instructions prepended to every provider's project document. */
export const PERSONA_PREPEND_FILE = 'instructions.prepend.md';

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/** Read a group's standing instructions without following symlinks. */
export function readGroupPersona(groupDir: string): string | null {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return null;
    const content = fs.readFileSync(fd, 'utf-8').trim();
    return content || null;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read group standing instructions; omitting persona', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Overwrite a group's standing instructions (webchat editor). Empty content
 * removes the file — an absent persona and an empty one compose identically.
 * O_NOFOLLOW like the reader: never write through a symlink.
 */
export function writeGroupPersona(groupDir: string, instructions: string): void {
  const file = path.join(groupDir, PERSONA_PREPEND_FILE);
  const content = instructions.trimEnd();
  if (!content.trim()) {
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return;
      throw err;
    }
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.writeSync(fd, `${content}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
