export type EmbeddingErrorCode =
  | 'configuration'
  | 'invalid_input'
  | 'authentication'
  | 'rate_limit'
  | 'request_rejected'
  | 'unavailable'
  | 'timeout'
  | 'invalid_response';

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly code: EmbeddingErrorCode,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}
