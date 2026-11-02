/** Structured HTTP outcome; response text is never a classification input. */
export class SourceFetchHttpError extends Error {
  constructor(readonly status: number, statusText: string) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "SourceFetchHttpError";
  }
}
