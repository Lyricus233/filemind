import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

import { MAX_PROCESSING_BATCH_SIZE } from './batch-processing.dto.js';

export class ListRebuildCandidatesQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PROCESSING_BATCH_SIZE)
  limit = MAX_PROCESSING_BATCH_SIZE;
}
