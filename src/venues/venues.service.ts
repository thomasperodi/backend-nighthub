import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, venues, events, promos, venue_tables } from '@prisma/client';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  async listVenues(): Promise<venues[]> {
    return await this.prisma.venues.findMany({
      orderBy: { created_at: 'desc' },
    });
  }

  async getVenue(id: string): Promise<venues> {
    const v = await this.prisma.venues.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Venue not found');
    return v;
  }

  async createVenue(input: {
    name: string;
    city?: string;
    radius_geofence?: number;
  }): Promise<venues> {
    if (!input || !input.name) {
      throw new BadRequestException('Missing required fields');
    }

    const data: Prisma.venuesCreateInput = {
      name: input.name,
      city: input.city ?? undefined,
    };

    if (input.radius_geofence !== undefined) {
      data.radius_geofence = input.radius_geofence;
    }

    return await this.prisma.venues.create({ data });
  }

  async updateVenue(
    id: string,
    updates: Partial<{
      name?: string;
      city?: string;
      radius_geofence?: number;
    }>,
  ): Promise<venues> {
    await this.getVenue(id);

    const data: Prisma.venuesUpdateInput = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.city !== undefined) data.city = updates.city;
    if (updates.radius_geofence !== undefined) {
      data.radius_geofence = updates.radius_geofence;
    }

    return await this.prisma.venues.update({ where: { id }, data });
  }

  async deleteVenue(id: string): Promise<venues> {
    await this.getVenue(id);
    return await this.prisma.venues.delete({ where: { id } });
  }

  async listEvents(venueId: string): Promise<events[]> {
    return await this.prisma.events.findMany({
      where: { venue_id: venueId },
      orderBy: { date: 'desc' },
    });
  }

  async listPromos(venueId: string): Promise<promos[]> {
    return await this.prisma.promos.findMany({
      where: { venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listVenueTables(venueId: string): Promise<venue_tables[]> {
    // Ensure venue exists
    await this.getVenue(venueId);

    return await this.prisma.venue_tables.findMany({
      where: { venue_id: venueId },
      orderBy: [{ zona: 'asc' }, { numero: 'asc' }, { nome: 'asc' }],
    });
  }

  async createVenueTablesBulk(
    venueId: string,
    body: CreateVenueTablesBulkDto,
  ): Promise<venue_tables[]> {
    await this.getVenue(venueId);

    const tables = body?.tables;
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new BadRequestException('tables[] is required');
    }

    // Keep it safe: avoid accidental huge payloads
    if (tables.length > 300) {
      throw new BadRequestException('Too many tables (max 300 per request)');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const t of tables) {
        if (!t?.nome || typeof t.nome !== 'string') {
          throw new BadRequestException('Each table must have nome');
        }

        const numero =
          t.numero === null || t.numero === undefined
            ? undefined
            : Number(t.numero);
        if (numero !== undefined && (!Number.isInteger(numero) || numero < 1)) {
          throw new BadRequestException('numero must be an integer >= 1');
        }

        const perTesta =
          t.per_testa === null || t.per_testa === undefined
            ? undefined
            : Number(t.per_testa);
        if (
          perTesta !== undefined &&
          (!Number.isFinite(perTesta) || perTesta < 0)
        ) {
          throw new BadRequestException('per_testa must be a number >= 0');
        }

        const costoMinimo =
          t.costo_minimo === null || t.costo_minimo === undefined
            ? undefined
            : Number(t.costo_minimo);
        if (
          costoMinimo !== undefined &&
          (!Number.isFinite(costoMinimo) || costoMinimo < 0)
        ) {
          throw new BadRequestException('costo_minimo must be a number >= 0');
        }

        const personeMax =
          t.persone_max === null || t.persone_max === undefined
            ? undefined
            : Number(t.persone_max);
        if (
          personeMax !== undefined &&
          (!Number.isInteger(personeMax) || personeMax < 1)
        ) {
          throw new BadRequestException('persone_max must be an integer >= 1');
        }

        // If numero is provided, treat it as an idempotent key within the venue
        if (numero !== undefined) {
          const existing = (await tx.venue_tables.findFirst({
            where: { venue_id: venueId, numero },
            select: { id: true },
          })) as { id: string } | null;

          if (existing) {
            await tx.venue_tables.update({
              where: { id: existing.id },
              data: {
                nome: t.nome,
                zona: t.zona ?? undefined,
                per_testa: perTesta,
                costo_minimo: costoMinimo,
                persone_max: personeMax,
              },
            });
          } else {
            await tx.venue_tables.create({
              data: {
                venue_id: venueId,
                nome: t.nome,
                zona: t.zona ?? undefined,
                numero,
                per_testa: perTesta,
                costo_minimo: costoMinimo,
                persone_max: personeMax,
              },
            });
          }
        } else {
          await tx.venue_tables.create({
            data: {
              venue_id: venueId,
              nome: t.nome,
              zona: t.zona ?? undefined,
              numero: undefined,
              per_testa: perTesta,
              costo_minimo: costoMinimo,
              persone_max: personeMax,
            },
          });
        }
      }
    });

    return this.listVenueTables(venueId);
  }

  async deleteVenueTable(
    venueId: string,
    tableId: string,
  ): Promise<venue_tables> {
    await this.getVenue(venueId);

    const existing = (await this.prisma.venue_tables.findUnique({
      where: { id: tableId },
      select: { id: true, venue_id: true },
    })) as { id: string; venue_id: string } | null;
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Table not found');
    }

    return await this.prisma.venue_tables.delete({ where: { id: tableId } });
  }

  async updateVenueTable(
    venueId: string,
    tableId: string,
    body: UpdateVenueTableDto,
  ): Promise<venue_tables> {
    await this.getVenue(venueId);

    const existing = (await this.prisma.venue_tables.findUnique({
      where: { id: tableId },
      select: { id: true, venue_id: true },
    })) as { id: string; venue_id: string } | null;
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Table not found');
    }

    const data: Prisma.venue_tablesUpdateInput = {};

    if (body?.nome !== undefined) {
      const trimmed = String(body.nome).trim();
      if (!trimmed) throw new BadRequestException('nome cannot be empty');
      data.nome = trimmed;
    }

    if (body?.zona !== undefined) {
      const trimmed = String(body.zona).trim();
      data.zona = trimmed.length ? trimmed : null;
    }

    if (body?.numero !== undefined && body.numero !== null) {
      const numero = Number(body.numero);
      if (!Number.isInteger(numero) || numero < 1) {
        throw new BadRequestException('numero must be an integer >= 1');
      }

      // Unique per venue: prevent collisions with another table
      const clash = (await this.prisma.venue_tables.findFirst({
        where: {
          venue_id: venueId,
          numero,
          id: { not: tableId },
        },
        select: { id: true },
      })) as { id: string } | null;
      if (clash) {
        throw new BadRequestException('numero already in use for this venue');
      }

      data.numero = numero;
    }

    if (body?.per_testa !== undefined && body.per_testa !== null) {
      const v = Number(body.per_testa);
      if (!Number.isFinite(v) || v < 0) {
        throw new BadRequestException('per_testa must be a number >= 0');
      }
      data.per_testa = v;
    }

    if (body?.costo_minimo !== undefined && body.costo_minimo !== null) {
      const v = Number(body.costo_minimo);
      if (!Number.isFinite(v) || v < 0) {
        throw new BadRequestException('costo_minimo must be a number >= 0');
      }
      data.costo_minimo = v;
    }

    if (body?.persone_max !== undefined && body.persone_max !== null) {
      const v = Number(body.persone_max);
      if (!Number.isInteger(v) || v < 1) {
        throw new BadRequestException('persone_max must be an integer >= 1');
      }
      data.persone_max = v;
    }

    // If user wants to clear numeric optional fields, allow explicit null
    if (body?.per_testa === null) data.per_testa = null;
    if (body?.costo_minimo === null) data.costo_minimo = null;
    if (body?.persone_max === null) data.persone_max = null;
    if (body?.numero === null) data.numero = null;

    return await this.prisma.venue_tables.update({
      where: { id: tableId },
      data,
    });
  }

  async getStats(venueId: string): Promise<{
    eventsCount: number;
    promosCount: number;
    reservationsCount: number;
    totalReservationAmount: number;
  }> {
    const [eventsCount, promosCount, reservationsCount, reservationsSum] =
      await this.prisma.$transaction([
        this.prisma.events.count({ where: { venue_id: venueId } }),
        this.prisma.promos.count({ where: { venue_id: venueId } }),
        this.prisma.reservations.count({
          where: { event: { venue_id: venueId } },
        }),
        this.prisma.reservations.aggregate({
          where: { event: { venue_id: venueId }, total_amount: { not: null } },
          _sum: { total_amount: true },
        }),
      ]);

    let totalReservationAmount = 0;
    const rawTotal = reservationsSum._sum?.total_amount;
    if (rawTotal !== null && rawTotal !== undefined) {
      const totalAsUnknown = rawTotal as unknown;
      if (
        typeof totalAsUnknown === 'object' &&
        totalAsUnknown !== null &&
        typeof (totalAsUnknown as Record<string, unknown>).toNumber ===
          'function'
      ) {
        totalReservationAmount = (
          totalAsUnknown as Record<string, () => number>
        ).toNumber();
      } else {
        totalReservationAmount = Number(rawTotal) || 0;
      }
    }

    return {
      eventsCount,
      promosCount,
      reservationsCount,
      totalReservationAmount,
    };
  }
}
