import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export const MAX_PROCESSING_BATCH_SIZE = 20;

export class BatchProcessingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PROCESSING_BATCH_SIZE)
  @IsUUID('all', { each: true })
  fileIds: string[];
}
