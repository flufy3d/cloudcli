// Minimal declarations for the `web-push` package, which ships no types.
// Only the surface this project uses is declared; extend it when a new API is
// taken into use. vapid-keys.service.ts currently opts out of checking with
// @ts-nocheck and can lean on these declarations once it migrates off that.
declare module 'web-push' {
  export interface WebPushSubscription {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  export interface WebPushOptions {
    gcmAPIKey?: string;
    vapidDetails?: {
      subject: string;
      publicKey: string;
      privateKey: string;
    };
    timeout?: number;
    headers?: Record<string, string>;
    proxy?: string;
  }

  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export function sendNotification(
    subscription: WebPushSubscription,
    payload?: string | null,
    options?: WebPushOptions,
  ): Promise<unknown>;

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  export function generateVAPIDKeys(): VapidKeys;
}
