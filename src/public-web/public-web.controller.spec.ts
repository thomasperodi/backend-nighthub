import type { Request, Response } from 'express';
import { PublicWebController } from './public-web.controller';
import { italianDay } from './pages/event-landing';
import type { PrismaService } from '../prisma/prisma.service';

function makeRes() {
  const res = {
    statusCode: 0,
    body: '',
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader() {
      return res;
    },
    type() {
      return res;
    },
    send(html: string) {
      res.body = html;
      return res;
    },
  };
  return res;
}

function makeReq(
  ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
) {
  return {
    protocol: 'http',
    headers: { 'user-agent': ua, 'x-forwarded-proto': 'https' },
    get: () => 'backend-nighthub-788g.vercel.app',
  } as unknown as Request;
}

const EVENT_ID = '6968f5c3-6c0a-4779-bd40-18be45db00af';

describe('PublicWebController', () => {
  let findUnique: jest.Mock;
  let controller: PublicWebController;

  beforeEach(() => {
    findUnique = jest.fn();
    controller = new PublicWebController({
      events: { findUnique },
    } as unknown as PrismaService);
  });

  it('serves the iOS association file for the NightHub app and /r/event/* links', () => {
    expect(controller.appleAppSiteAssociation()).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['4S4XRSW6AC.com.thomas88.nighthub'],
            components: [{ '/': '/r/event/*' }],
          },
        ],
      },
    });
  });

  it('renders an event preview with link-preview tags, deep link with the PR code and App Store button', async () => {
    findUnique.mockResolvedValue({
      id: EVENT_ID,
      name: 'Sabato <Deep> House',
      image: `events/${EVENT_ID}.jpg`,
      date: new Date(Date.UTC(2099, 9, 17)),
      start_time: new Date(Date.UTC(1970, 0, 1, 23, 0)),
      end_time: new Date(Date.UTC(1970, 0, 1, 5, 0)),
      status: 'DRAFT',
      venue: { name: 'Paradise', city: 'Piacenza' },
    });
    const res = makeRes();

    await controller.eventLanding(
      EVENT_ID,
      'MARCO',
      makeReq(),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(200);
    // Event name is escaped, never injected as HTML.
    expect(res.body).toContain('Sabato &lt;Deep&gt; House');
    expect(res.body).not.toContain('<Deep>');
    expect(res.body).toContain(
      'property="og:image" content="https://backend-nighthub-788g.vercel.app/api/media/events/',
    );
    expect(res.body).toContain(`nighthub://event/${EVENT_ID}?pr=MARCO`);
    expect(res.body).toContain('https://apps.apple.com/app/id6816712313');
    expect(res.body).toContain('23:00–05:00');
  });

  it('says "coming soon" to Android users while there is no Play Store listing', async () => {
    findUnique.mockResolvedValue(null);
    const res = makeRes();

    await controller.eventLanding(
      EVENT_ID,
      undefined,
      makeReq('Mozilla/5.0 (Linux; Android 15)'),
      res as unknown as Response,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Serata non trovata');
    expect(res.body).toContain("L'app per Android arriva presto.");
  });

  it('does not query the database for an id that is not a UUID', async () => {
    const res = makeRes();
    await controller.eventLanding(
      'not-a-uuid',
      undefined,
      makeReq(),
      res as unknown as Response,
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
  });

  it('shows that a past night is over', async () => {
    findUnique.mockResolvedValue({
      id: EVENT_ID,
      name: 'Bello Figo',
      image: null,
      date: new Date(Date.UTC(2020, 7, 30)),
      start_time: new Date(Date.UTC(1970, 0, 1, 22, 0)),
      end_time: null,
      status: 'DRAFT',
      venue: { name: 'Paradise', city: null },
    });
    const res = makeRes();
    await controller.eventLanding(
      EVENT_ID,
      undefined,
      makeReq(),
      res as unknown as Response,
    );
    expect(res.body).toContain('Questa serata è già conclusa');
  });

  it('serves the legal pages with the owner and contact', () => {
    expect(controller.privacy()).toContain('Thomas Perodi');
    expect(controller.privacy()).toContain('perodithomas88@gmail.com');
    expect(controller.terms()).toContain('Termini di servizio');
    expect(controller.support()).toContain('perodithomas88@gmail.com');
    expect(controller.support()).toContain('Elimina account');
  });

  it('formats the calendar day without timezone drift', () => {
    expect(italianDay('2026-10-17')).toBe('Sabato 17 ottobre');
  });
});
