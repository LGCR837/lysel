export class LyselError extends Error {
  constructor(message: string, readonly code = 'lysel_error') {
    super(message);
    this.name = 'LyselError';
  }
}

export class AdapterError extends LyselError {
  constructor(message: string, code = 'adapter_error', readonly status?: number) {
    super(message, code);
    this.name = 'AdapterError';
  }
}

export class CapabilityError extends LyselError {
  constructor(feature: string) {
    super(`平台不支持该能力: ${feature}`, 'capability_missing');
    this.name = 'CapabilityError';
  }
}
