import {
  IsInt,
  IsMimeType,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  originalName: string;

  @IsMimeType()
  mimeType: string;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  sizeBytes: number;
}
