import type { ArgumentsHost } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';

function makeHost() {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'GET', originalUrl: '/api/events/abc' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  it('turns a malformed id (Prisma P2023) into a 400 instead of a 500', () => {
    const { host, status, json } = makeHost();
    const prismaError = Object.assign(
      new Error('Inconsistent column data: Error creating UUID'),
      {
        code: 'P2023',
      },
    );

    new AllExceptionsFilter().catch(prismaError, host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        message: 'Identificativo non valido',
      }),
    );
  });

  it('still hides any other unexpected error behind a generic 500', () => {
    const { host, status, json } = makeHost();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    new AllExceptionsFilter().catch(new Error('db exploded'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        message: 'Internal server error',
      }),
    );
  });
});
