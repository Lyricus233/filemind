export class VectorStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'configuration'
      | 'invalid_input'
      | 'schema_mismatch'
      | 'invalid_response'
      | 'unavailable'
      | 'timeout',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'VectorStoreError';
  }
}

export function assertMilvusSuccess(status: {
  error_code: string | number;
  code?: number;
}) {
  if (
    !['Success', 0].includes(status.error_code) ||
    (status.code !== undefined && status.code !== 0)
  ) {
    throw new VectorStoreError('Milvus operation failed', 'unavailable', true);
  }
}
