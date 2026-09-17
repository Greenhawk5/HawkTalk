export type AdmissionDecision = 'allowed' | 'quota_exceeded' | 'rate_limited' | 'blocked' | 'unavailable';

export interface AdmissionGate {
  admit(userId: number, updateId: number): Promise<AdmissionDecision>;
}

export function admissionReply(decision: Exclude<AdmissionDecision, 'allowed'>): string {
  switch (decision) {
    case 'quota_exceeded': return 'Your message allowance has been reached. Please try again tomorrow.';
    case 'rate_limited': return 'Please slow down and try again later.';
    case 'blocked': return 'This account cannot use the assistant.';
    case 'unavailable': return 'The assistant is temporarily unavailable. Please try again later.';
  }
}
