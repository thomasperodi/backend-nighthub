/**
 * Stable machine-readable codes for errors that clients handle in a specific way (the app
 * reopens the right signup step, the door scanner shows a precise outcome...). Clients must
 * switch on `code`, never on `message`: messages are free text and may be reworded.
 *
 * Response shape: `{ statusCode, message, code, requestId }` (see AllExceptionsFilter).
 */
export type ErrorCode =
  // Registration
  | 'USERNAME_TAKEN'
  | 'EMAIL_TAKEN'
  | 'BIRTH_DATE_REQUIRED'
  | 'BIRTH_DATE_INVALID'
  | 'UNDERAGE'
  // Booking
  | 'EVENT_CANCELLED'
  | 'EVENT_CLOSED'
  | 'ALREADY_IN_LIST'
  | 'TABLE_ALREADY_BOOKED'
  // Door scan (reservation QR)
  | 'QR_NOT_FOUND'
  | 'QR_NOT_ENTRY'
  | 'QR_WRONG_EVENT'
  | 'RESERVATION_CANCELLED'
  // Door scan (PR season pass)
  | 'PASS_NOT_FOUND'
  | 'PASS_WRONG_VENUE'
  | 'PASS_INACTIVE'
  | 'PASS_REVOKED'
  | 'PASS_NOT_YET_VALID'
  | 'PASS_EXPIRED';

/** Exception body with a stable code: `throw new ConflictException(coded('EMAIL_TAKEN', '...'))`. */
export function coded(code: ErrorCode, message: string) {
  return { message, code };
}
