import type { OCHttp } from '../../transport/http.ts';

export interface LoginResult {
  access_token: string;
  refresh_token: string;
  user?: Record<string, any>;
}

export async function loginWithPassword(
  http: OCHttp,
  identifier: string,
  password: string,
  deviceId: string,
): Promise<LoginResult> {
  const res = await http.request<LoginResult>('/v1/auth/login', {
    method: 'POST',
    auth: false,
    body: {
      identifier,
      username: identifier,
      password,
      device_id: deviceId,
      platform: 'lysel',
      app_version: '0.1.0',
    },
  });
  if (!res?.access_token) throw new Error('登录失败，未返回 access_token');
  return res;
}

export async function refreshSession(http: OCHttp, refreshToken: string): Promise<LoginResult> {
  return http.request<LoginResult>('/v1/auth/refresh', {
    method: 'POST',
    auth: false,
    body: { refresh_token: refreshToken },
  });
}
