export type DevIdentityConfig = {
  enabled: boolean;
  subject: string;
  roles: string[];
  courtIds: string[];
};

export type RuntimeConfig = {
  baseUrl: string;
  devIdentity?: DevIdentityConfig;
};

function splitCsv(value: string | undefined): string[] {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getRuntimeConfig(): RuntimeConfig {
  const env = import.meta.env;
  const enabled = env.VITE_DCIECMS_DEV_IDENTITY === 'true';

  return {
    baseUrl: env.VITE_DCIECMS_API_BASE_URL || '',
    devIdentity: enabled
      ? {
          enabled: true,
          subject: env.VITE_DCIECMS_DEV_SUBJECT || '',
          roles: splitCsv(env.VITE_DCIECMS_DEV_ROLES),
          courtIds: splitCsv(env.VITE_DCIECMS_DEV_COURTS)
        }
      : undefined
  };
}
