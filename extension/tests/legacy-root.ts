import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Read-only historical fixtures remain in their original checkout, outside the public repository.
export const legacyRoot = process.env.DLMU_LEGACY_ROOT
  ? resolve(process.env.DLMU_LEGACY_ROOT)
  : fileURLToPath(new URL('..', import.meta.url));

export const legacyPath = (relative: string) => resolve(legacyRoot, relative);
export const legacyDirectory = (relative: string) => legacyPath(relative) + sep;
