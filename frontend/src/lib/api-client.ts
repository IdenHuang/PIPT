import { appConfig } from '@/config/aws-config';
import { authService } from '@/lib/auth';

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  body?: unknown;
  headers?: Record<string, string>;
}

export class ApiClient {
  private baseUrl: string;
  // Tracks in-flight GET requests so concurrent identical reads share one call.
  private inFlightGets = new Map<string, Promise<unknown>>();

  constructor() {
    this.baseUrl = appConfig.api.endpoint;
    // In-flight GETs are keyed on endpoint only, so never let one started by a
    // previous principal be handed to the next one after a session change.
    authService.onSessionReset(() => this.reset());
  }

  /** Forget all in-flight GET de-duplication entries. */
  reset(): void {
    this.inFlightGets.clear();
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const token = await authService.getIdToken();
    if (token) {
      headers['Authorization'] = token; // Don't add "Bearer " prefix
    }

    return headers;
  }

  async request<T>(
    endpoint: string,
    options: ApiRequestOptions = {}
  ): Promise<T> {
    const method = options.method ?? 'GET';

    // De-duplicate concurrent identical GET requests. If the same GET is already
    // in flight, return its promise instead of issuing a second network call.
    // Callers of GETs treat responses as read-only, so sharing the resolved
    // value is safe. Non-GET requests are never deduplicated.
    if (method === 'GET') {
      const existing = this.inFlightGets.get(endpoint);
      if (existing) return existing as Promise<T>;
      const pending: Promise<T> = this.executeRequest<T>(endpoint, options).finally(() => {
        // Only remove our own entry; after reset() a newer request for the
        // same endpoint may own the slot.
        if (this.inFlightGets.get(endpoint) === pending) {
          this.inFlightGets.delete(endpoint);
        }
      });
      this.inFlightGets.set(endpoint, pending as Promise<unknown>);
      return pending;
    }

    return this.executeRequest<T>(endpoint, options);
  }

  private async executeRequest<T>(
    endpoint: string,
    options: ApiRequestOptions = {}
  ): Promise<T> {
    const { method = 'GET', body, headers = {} } = options;

    const authHeaders = await this.getAuthHeaders();
    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      method,
      headers: {
        ...authHeaders,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired or invalid — redirect to login
        window.location.href = '/login';
        throw new Error('Session expired. Please sign in again.');
      }
      // Try to extract error message from response body
      let errorMessage = `API Error: ${response.status} ${response.statusText}`;
      try {
        const errorBody = await response.json();
        if (errorBody?.error) {
          errorMessage = errorBody.error;
        }
      } catch {
        // Response body wasn't JSON, use default message
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }

  // Student endpoints
  async getStudentData() {
    return this.request('/student/data');
  }

  // Instructor endpoints
  async getInstructorData() {
    return this.request('/instructor/data');
  }

  // Admin endpoints
  async getAdminData() {
    return this.request('/admin/data');
  }
}

export const apiClient = new ApiClient();
