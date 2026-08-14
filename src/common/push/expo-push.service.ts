import { Injectable, Logger } from '@nestjs/common';

// Shared Expo push sender. New notification call sites should use this instead of
// adding another private copy - four services (staff/friends/reservations/promos)
// already have their own near-identical implementation; that consolidation is a
// separate follow-up, but new code should not add a fifth copy.
@Injectable()
export class ExpoPushService {
  private readonly logger = new Logger(ExpoPushService.name);

  private maskToken(token: string) {
    if (!token) return 'empty';
    if (token.length <= 14) return token;
    return `${token.slice(0, 10)}...${token.slice(-4)}`;
  }

  async send(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const token = String(params.token || '').trim();
    const isExpoToken = /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(token);
    if (!isExpoToken) return;

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: token,
          title: params.title,
          body: params.body,
          sound: 'default',
          priority: 'high',
          content_available: true,
          data: params.data ?? {},
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `Expo push HTTP ${response.status} for ${this.maskToken(token)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Expo push exception for ${this.maskToken(token)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
