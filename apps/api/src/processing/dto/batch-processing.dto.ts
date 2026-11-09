import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';

export class BatchProcessingDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  fileIds: string[];
}
