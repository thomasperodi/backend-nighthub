export class RegisterDto {
  email: string;
  password: string;
  role?: string; // opzionale, default 'user'
}
