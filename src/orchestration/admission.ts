export type AdmissionDecision = 'allowed' | 'quota_exceeded' | 'rate_limited' | 'blocked' | 'unavailable';

export interface AdmissionGate {
  admit(userId: number, updateId: number): Promise<AdmissionDecision>;
}

export function admissionReply(decision: Exclude<AdmissionDecision, 'allowed'>): string {
  switch (decision) {
    case 'quota_exceeded': return '📊 You’ve reached today’s message allowance — it resets tomorrow. See you then! 🌙';
    case 'rate_limited': return 'Easy there 🙂 Give me a beat and try again in a moment.';
    case 'blocked': return 'This account can’t use the assistant right now. If that looks wrong, contact the team.';
    case 'unavailable': return 'I’m briefly unavailable — please try again in a minute.';
  }
}
