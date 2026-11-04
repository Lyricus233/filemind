import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class ListDuplicatesQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
