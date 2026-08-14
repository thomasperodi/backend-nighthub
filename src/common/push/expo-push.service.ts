import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Shared Expo push sender (mobile app only - see WebPushService for the PWA/browser
// channel). New notification call sites should use this instead of adding another private
// copy - four services (staff/friends/reservations/promos) used to each have their own
// near-identical implementation; they now go through PushDispatchService instead.
@Injectable()
export class ExpoPushService {
  private readonly logger = new Logger(ExpoPushService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    /** When provided, a token Expo reports as permanently dead (DeviceNotRegistered) is
     * cleared from users.push_token instead of being retried forever on every future send. */
    userId?: string;
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

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        this.logger.warn(
          `Expo push HTTP ${response.status} for ${this.maskToken(token)}`,
        );
        return;
      }

      const ticketError = payload?.data?.details?.error;
      if (ticketError === 'DeviceNotRegistered' && params.userId) {
        await this.prisma.users
          .updateMany({
            where: { id: params.userId, push_token: token },
            data: { push_token: null, push_token_updated_at: null },
          })
          .catch(() => undefined);
        return;
      }

      const ticketStatus = payload?.data?.status;
      if (ticketStatus && ticketStatus !== 'ok') {
        this.logger.warn(
          `Expo push rejected for ${this.maskToken(token)}: ${ticketError ?? ticketStatus}`,
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
