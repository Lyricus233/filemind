import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageService {
  private readonly directory: string;

  constructor(configService: ConfigService) {
    this.directory = resolve(
      configService.get<string>('STORAGE_DIR') ?? './storage',
    );
  }

  async save(buffer: Buffer): Promise<string> {
    await mkdir(this.directory, { recursive: true });

    const storageKey = randomUUID();

    await writeFile(join(this.directory, storageKey), buffer, {
      flag: 'wx',
    });

    return storageKey;
  }

  async remove(storageKey: string): Promise<void> {
    await rm(join(this.directory, storageKey), {
      force: true,
    });
  }

  async openReadStream(storageKey: string): Promise<ReadStream> {
    const handle = await open(join(this.directory, storageKey), 'r');

    return handle.createReadStream();
  }
}
