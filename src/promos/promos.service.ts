import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PromoStatus } from '@prisma/client';

@Injectable()
export class PromosService {
  constructor(private readonly prisma: PrismaService) {}
  private readonly logger = new Logger(PromosService.name);
  private readonly pushDebug = process.env.PUSH_DEBUG === '1';

  private maskToken(token: string) {
    if (!token) return 'empty';
    if (token.length <= 14) return token;
    return `${token.slice(0, 10)}...${token.slice(-4)}`;
  }

  private async sendExpoPush(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const token = String(params.token || '').trim();
    const isExpoToken = /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(token);
    if (!isExpoToken) {
      this.logger.warn(
        `Push skipped: invalid Expo token format (${this.maskToken(token)})`,
      );
      return;
    }

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

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        this.logger.error(
          `Expo push HTTP ${response.status} for ${this.maskToken(token)}: ${JSON.stringify(payload)}`,
        );
        return;
      }

      const payloadData =
        payload && typeof payload === 'object' && 'data' in payload
          ? (payload as { data?: unknown }).data
          : undefined;

      const ticketStatus =
        payloadData &&
        typeof payloadData === 'object' &&
        !Array.isArray(payloadData) &&
        'status' in payloadData &&
        typeof (payloadData as { status?: unknown }).status === 'string'
          ? (payloadData as { status: string }).status
          : undefined;

      if (ticketStatus && ticketStatus !== 'ok') {
        this.logger.error(
          `Expo push rejected for ${this.maskToken(token)}: ${JSON.stringify(payloadData)}`,
        );
        return;
      }

      if (this.pushDebug) {
        const pushType =
          typeof params.data?.type === 'string' ? params.data.type : 'unknown';
        this.logger.log(
          `Expo push sent (${this.maskToken(token)}) type=${pushType}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Expo push exception for ${this.maskToken(token)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async sendPromoCreatedPush(promo: {
    id: string;
    venue_id: string;
    event_id: string | null;
    title: string;
    description: string | null;
  }) {
    const users = await this.prisma.users.findMany({
      where: {
        role: 'client',
        push_token: { not: null },
      },
      select: {
        id: true,
        username: true,
        push_token: true,
      },
    });
    if (!users.length) return;

    const rule = this.parseTargetRule(promo.description);
    const normalizedCustomers = new Set(
      (rule?.customers ?? []).map((item) => this.normalizeIdentity(item)),
    );

    const entryRows = await this.prisma.$queryRaw<
      Array<{ user_id: string; last_entry_at: Date | null }>
    >(
      Prisma.sql`
        SELECT e."user_id", MAX(e."created_at") AS last_entry_at
        FROM "entries" e
        INNER JOIN "events" ev ON ev."id" = e."event_id"
        WHERE e."user_id" IS NOT NULL
          AND ev."venue_id" = ${promo.venue_id}::uuid
        GROUP BY e."user_id"
      `,
    );

    const lastEntryByUser = new Map<string, Date>();
    for (const row of entryRows) {
      if (row.user_id && row.last_entry_at) {
        lastEntryByUser.set(row.user_id, new Date(row.last_entry_at));
      }
    }

    const weeks = Math.max(1, rule?.weeks ?? 1);
    const threshold = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);

    const recipients = users.filter((user) => {
      const normalizedUserId = this.normalizeIdentity(user.id);
      const normalizedUsername = user.username
        ? this.normalizeIdentity(user.username)
        : null;
      const lastEntry = lastEntryByUser.get(user.id);
      const hasAnyEntryAtVenue = !!lastEntry;

      if (!rule?.segment) return true;

      if (rule.segment === 'specific') {
        if (!normalizedCustomers.size) return false;
        return (
          normalizedCustomers.has(normalizedUserId) ||
          (!!normalizedUsername && normalizedCustomers.has(normalizedUsername))
        );
      }

      if (rule.segment === 'new') {
        return !hasAnyEntryAtVenue;
      }

      if (rule.segment === 'loyal') {
        return !!lastEntry && lastEntry >= threshold;
      }

      if (rule.segment === 'churn') {
        return !!lastEntry && lastEntry < threshold;
      }

      return true;
    });

    if (!recipients.length) return;

    const venue = await this.prisma.venues.findUnique({
      where: { id: promo.venue_id },
      select: { name: true },
    });
    const venueName = venue?.name || 'un locale';

    const uniqueTokens = Array.from(
      new Set(
        recipients
          .map((user) => user.push_token)
          .filter((token): token is string => !!token)
          .map((token) => token.trim()),
      ),
    );

    await Promise.allSettled(
      uniqueTokens.map((token) =>
        this.sendExpoPush({
          token,
          title: 'Nuova promo disponibile',
          body: `${venueName}: ${promo.title}`,
          data: {
            type: 'promo_created',
            promo_id: promo.id,
            venue_id: promo.venue_id,
            event_id: promo.event_id,
          },
        }),
      ),
    );
  }

  private parseTargetRule(description?: string | null): {
    segment?: 'specific' | 'new' | 'loyal' | 'churn';
    weeks?: number;
    customers?: string[];
  } | null {
    if (!description) return null;
    const line = description
      .split('\n')
      .map((row) => row.trim())
      .find((row) => row.toLowerCase().startsWith('[target_rule]'));
    if (!line) return null;

    const payload = line.replace(/^\[target_rule\]\s*/i, '').trim();
    if (!payload) return null;

    const pairs = payload
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean);
    const kv = new Map<string, string>();
    for (const pair of pairs) {
      const [key, ...rest] = pair.split('=');
      if (!key || rest.length === 0) continue;
      kv.set(key.trim().toLowerCase(), rest.join('=').trim());
    }

    const segmentRaw = (kv.get('segment') || '').toLowerCase();
    const segment = ['specific', 'new', 'loyal', 'churn'].includes(segmentRaw)
      ? (segmentRaw as 'specific' | 'new' | 'loyal' | 'churn')
      : undefined;

    const weeksRaw = Number(kv.get('weeks'));
    const weeks =
      Number.isFinite(weeksRaw) && weeksRaw > 0
        ? Math.floor(weeksRaw)
        : undefined;

    const customers = (kv.get('customers') || '')
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);

    return { segment, weeks, customers };
  }

  private normalizeIdentity(input: string): string {
    return input.trim().toLowerCase().replace(/^@/, '');
  }

  async listActivePromos() {
    return this.prisma.promos.findMany({
      where: { status: PromoStatus.active },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        venue_id: true,
        event_id: true,
        title: true,
        description: true,
        discount_type: true,
        discount_value: true,
        status: true,
        created_at: true,
      },
    });
  }

  async listActivePromosForUser(userId: string) {
    const promos = await this.listActivePromos();
    if (!promos.length) return promos;

    const [user, userEntries] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: userId },
        select: { id: true, username: true },
      }),
      this.prisma.entries.findMany({
        where: { user_id: userId },
        select: { created_at: true, event_id: true },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const eventIds = Array.from(
      new Set(userEntries.map((entry) => entry.event_id).filter(Boolean)),
    );
    const events = eventIds.length
      ? await this.prisma.events.findMany({
          where: { id: { in: eventIds } },
          select: { id: true, venue_id: true },
        })
      : [];

    const venueIdByEventId = new Map<string, string>();
    for (const ev of events) {
      if (ev.venue_id) {
        venueIdByEventId.set(ev.id, ev.venue_id);
      }
    }

    const byVenue = new Map<string, Date[]>();
    for (const entry of userEntries) {
      const venueId = venueIdByEventId.get(entry.event_id);
      if (!venueId) continue;
      const arr = byVenue.get(venueId) ?? [];
      arr.push(new Date(entry.created_at));
      byVenue.set(venueId, arr);
    }

    const normalizedUserId = this.normalizeIdentity(userId);
    const normalizedUsername = user?.username
      ? this.normalizeIdentity(user.username)
      : null;

    return promos.filter((promo) => {
      const rule = this.parseTargetRule(promo.description);
      if (!rule?.segment) return true;

      const venueId = promo.venue_id;
      if (!venueId) return true;

      const entryDates = byVenue.get(venueId) ?? [];
      const hasAnyEntryAtVenue = entryDates.length > 0;

      if (rule.segment === 'new') {
        return !hasAnyEntryAtVenue;
      }

      if (rule.segment === 'specific') {
        const allowed = (rule.customers ?? []).map((item) =>
          this.normalizeIdentity(item),
        );
        if (!allowed.length) return false;
        return (
          allowed.includes(normalizedUserId) ||
          (!!normalizedUsername && allowed.includes(normalizedUsername))
        );
      }

      const weeks = Math.max(1, rule.weeks ?? 1);
      const threshold = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);

      if (rule.segment === 'loyal') {
        return entryDates.some((date) => date >= threshold);
      }

      if (rule.segment === 'churn') {
        if (!hasAnyEntryAtVenue) return false;
        const lastEntry = entryDates[0];
        return lastEntry < threshold;
      }

      return true;
    });
  }

  async assertEventBelongsToVenue(eventId: string, venueId: string) {
    const e = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!e) throw new NotFoundException('Event not found');
    if (e.venue_id !== venueId) throw new ForbiddenException('Forbidden');
  }

  async listActiveByEvent(eventId: string) {
    return this.prisma.promos.findMany({
      where: { event_id: eventId, status: PromoStatus.active },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        venue_id: true,
        event_id: true,
        title: true,
        description: true,
        discount_type: true,
        discount_value: true,
        status: true,
        created_at: true,
      },
    });
  }

  async listActiveByVenue(venueId: string) {
    return this.prisma.promos.findMany({
      where: { venue_id: venueId, status: PromoStatus.active },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        venue_id: true,
        event_id: true,
        title: true,
        description: true,
        discount_type: true,
        discount_value: true,
        status: true,
        created_at: true,
      },
    });
  }

  async listPromos() {
    return this.prisma.promos.findMany({ orderBy: { created_at: 'desc' } });
  }

  async getPromo(id: string) {
    const p = await this.prisma.promos.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Promo not found');
    return p;
  }

  async listByEvent(eventId: string) {
    return this.prisma.promos.findMany({
      where: { event_id: eventId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listByEventForVenue(eventId: string, venueId: string) {
    return this.prisma.promos.findMany({
      where: { event_id: eventId, venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listByVenue(venueId: string) {
    return this.prisma.promos.findMany({
      where: { venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  async createPromo(input: Partial<Prisma.promosCreateInput>) {
    const p = await this.prisma.promos.create({ data: input as any });

    // Fire-and-forget: the push fan-out to all clients shouldn't block the response to
    // whoever created the promo.
    void this.sendPromoCreatedPush({
      id: p.id,
      venue_id: p.venue_id,
      event_id: p.event_id,
      title: p.title,
      description: p.description,
    }).catch((error) => {
      this.logger.warn(
        `sendPromoCreatedPush failed for promo ${p.id}: ${String(error)}`,
      );
    });

    return p;
  }

  async updatePromo(id: string, updates: Partial<Prisma.promosUpdateInput>) {
    await this.getPromo(id);
    return this.prisma.promos.update({ where: { id }, data: updates as any });
  }

  async deletePromo(id: string) {
    await this.getPromo(id);
    return this.prisma.promos.delete({ where: { id } });
  }
}
