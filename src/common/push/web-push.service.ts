import { Injectable, Logger } from '@nestjs/common';
import webpush from 'web-push';
import { PrismaService } from '../../prisma/prisma.service';

export type PushMessage = {
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

/**
 * Web Push (VAPID) sender for the PWA - separate from ExpoPushService (mobile). A user can
 * have any number of `push_subscriptions` rows (one per browser/device), unlike the single
 * `users.push_token` column Expo uses.
 */
@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private configured = false;

  constructor(private readonly prisma: PrismaService) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:support@nighthub.app';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.configured = true;
    } else {
      this.logger.warn(
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set - Web Push is disabled',
      );
    }
  }

  async sendToUser(userId: string, message: PushMessage): Promise<void> {
    if (!this.configured) return;

    const subscriptions = await this.prisma.push_subscriptions.findMany({
      where: { user_id: userId },
    });
    if (!subscriptions.length) return;

    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      data: message.data ?? {},
    });

    await Promise.all(
      subscriptions.map((subscription) =>
        this.sendToSubscription(subscription, payload),
      ),
    );
  }

  private async sendToSubscription(
    subscription: {
      id: string;
      endpoint: string;
      p256dh: string;
      auth_key: string;
    },
    payload: string,
  ): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
        },
        payload,
      );
    } catch (error: unknown) {
      const statusCode =
        error && typeof error === 'object' && 'statusCode' in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : undefined;

      // 404/410: the push service confirms this endpoint is gone for good (uninstalled,
      // permission revoked, browser data cleared) - clean it up instead of retrying forever.
      if (statusCode === 404 || statusCode === 410) {
        await this.prisma.push_subscriptions
          .delete({ where: { id: subscription.id } })
          .catch(() => undefined);
        return;
      }

      this.logger.warn(
        `Web push send failed for subscription ${subscription.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
