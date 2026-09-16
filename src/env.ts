export interface AppEnv {
  APP_ENV: 'development' | 'staging' | 'production';
  DB: D1Database;
}

export function validateEnv(env: Partial<AppEnv>): asserts env is AppEnv {
  if (
    !['development', 'staging', 'production'].includes(env.APP_ENV ?? '') ||
    !env.DB ||
    typeof env.DB.prepare !== 'function'
  ) {
    throw new Error('Invalid environment configuration');
  }
}
