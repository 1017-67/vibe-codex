export class VibeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "VibeError";
  }
}

export function toErrorPayload(error: unknown) {
  if (error instanceof VibeError) {
    return { error: { code: error.code, message: error.message, details: error.details } };
  }
  if (error instanceof Error) {
    return { error: { code: "INTERNAL_ERROR", message: error.message, details: {} } };
  }
  return { error: { code: "INTERNAL_ERROR", message: String(error), details: {} } };
}
