export class Fault extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function check(condition: unknown, message: string, status = 400, code?: string): asserts condition {
  if (!condition) throw new Fault(status, message, code);
}

export function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
