export class RegisterDto {
  email: string;
  username: string;
  password: string;
  role?: string; // opzionale, default 'user'
}
