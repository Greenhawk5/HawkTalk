// Admin CMS error model. Codes are stable and safe to surface; details never
// include secrets, SQL, or provider errors.

export type AdminErrorKind =
  | 'not_authorized'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'storage_failed';

export class AdminError extends Error {
  readonly kind: AdminErrorKind;

  constructor(kind: AdminErrorKind, message: string) {
    super(message);
    this.name = 'AdminError';
    this.kind = kind;
  }
}

export const ADMIN_ERROR_TEXT: Record<AdminErrorKind, string> = {
  not_authorized: 'You are not authorized to use admin commands.',
  not_found: 'That no longer exists — it may have been removed.',
  validation_failed: 'That value looks invalid. Check the format and try again.',
  storage_failed: 'The admin service is briefly unavailable. Please try again in a moment.',
  conflict: 'This changed since you opened it. Reload and try again.',
};

export function adminErrorText(kind: AdminErrorKind): string {
  return ADMIN_ERROR_TEXT[kind];
}
