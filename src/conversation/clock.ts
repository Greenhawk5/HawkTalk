export interface Clock {
  now(): string;
}

export class RuntimeClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export function createTestClock(initial: string): Clock {
  const current = initial;
  return {
    now(): string {
      return current;
    },
  } as Clock;
}