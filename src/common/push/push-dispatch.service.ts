import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ExpoPushService } from './expo-push.service';
import { WebPushService, type PushMessage } from './web-push.service';

/**
 * Single entry point for sending a notification to a user across every channel they might
 * be reachable on - Expo (mobile app, single `users.push_token`) and Web Push (PWA, any
 * number of `push_subscriptions`). Callers no longer need to know which channel(s) apply;
 * this also replaces the four near-identical private `sendExpoPush` copies that used to
 * live in reservations/staff/friends/promos and only ever reached Expo.
 */
@Injectable()
export class PushDispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPush: ExpoPushService,
    private readonly webPush: WebPushService,
  ) {}

  async notifyUser(userId: string, message: PushMessage): Promise<void> {
    if (!userId) return;

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { push_token: true },
    });

    await Promise.all([
      user?.push_token
        ? this.expoPush.send({
            userId,
            token: user.push_token,
            title: message.title,
            body: message.body,
            data: message.data,
          })
        : Promise.resolve(),
      this.webPush.sendToUser(userId, message),
    ]);
  }
}
