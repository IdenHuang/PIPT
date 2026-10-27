import { beforeEach, describe, expect, it, vi } from 'vitest';

// Session-boundary cache reset (finding f-ccad2e78). Amplify and the API config
// are mocked so auth.ts / api-client.ts load without a real Cognito setup.
vi.mock('aws-amplify/auth', () => ({
  signIn: vi.fn(async () => ({ isSignedIn: false, nextStep: { signInStep: 'CONFIRM_SIGN_UP' } })),
  signOut: vi.fn(async () => undefined),
  signUp: vi.fn(),
  fetchAuthSession: vi.fn(async () => ({ tokens: undefined })),
  confirmSignUp: vi.fn(),
  confirmSignIn: vi.fn(),
  resetPassword: vi.fn(),
  confirmResetPassword: vi.fn(),
  resendSignUpCode: vi.fn(),
}));
vi.mock('@/config/aws-config', () => ({ appConfig: { api: { endpoint: 'https://api.example/' } } }));

import { peekCached, setCached } from './dataCache';
import { authService } from './auth';
import { ApiClient } from './api-client';
import { patientsCacheKey } from '@/services/studentService';

describe('session cache reset', () => {
  beforeEach(() => {
    setCached('alice@example.com:student:patients:g1', [{ patient_id: 'p1' }]);
  });

  it('sign-out clears the shared data cache', async () => {
    await authService.signOut();
    expect(peekCached('alice@example.com:student:patients:g1')).toBeUndefined();
  });

  it('sign-in clears the shared data cache', async () => {
    await authService.signIn('bob@example.com', 'pw').catch(() => undefined);
    expect(peekCached('alice@example.com:student:patients:g1')).toBeUndefined();
  });

  it('sign-out drops in-flight GET de-duplication entries', async () => {
    const client = new ApiClient();
    const pending = new Promise(() => {}); // never settles
    (client as unknown as { inFlightGets: Map<string, Promise<unknown>> }).inFlightGets.set('student/me', pending);

    await authService.signOut();

    expect((client as unknown as { inFlightGets: Map<string, Promise<unknown>> }).inFlightGets.size).toBe(0);
  });
});

describe('patientsCacheKey', () => {
  it('binds the key to the user', () => {
    expect(patientsCacheKey('alice@example.com', 'g1')).not.toBe(patientsCacheKey('bob@example.com', 'g1'));
  });

  it('returns undefined without an identity so nothing is cached', () => {
    expect(patientsCacheKey(undefined, 'g1')).toBeUndefined();
    expect(patientsCacheKey('', 'g1')).toBeUndefined();
  });
});
