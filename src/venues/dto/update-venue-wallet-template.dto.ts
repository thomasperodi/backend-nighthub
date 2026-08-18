import { IsOptional, IsString, Matches, ValidateIf } from 'class-validator';

// Apple PassKit expects colors as literal `rgb(r, g, b)` strings, not hex - validated here so
// a malformed value fails fast with a clear error instead of silently producing an invalid
// (or unsigned) .pkpass later.
const RGB_PATTERN = /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/i;

export class UpdateVenueWalletTemplateDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(RGB_PATTERN, {
    message: 'background_color must look like "rgb(18, 20, 25)"',
  })
  background_color?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(RGB_PATTERN, {
    message: 'foreground_color must look like "rgb(245, 247, 251)"',
  })
  foreground_color?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(RGB_PATTERN, {
    message: 'label_color must look like "rgb(216, 179, 106)"',
  })
  label_color?: string | null;
}
