export interface InstallReporterOptions {
  stateDir?: string;
  appVersion?: string;
  guid?: string;
  baseUrl?: string;
  channel?: number;
  logger?: {
    info?: (message: string, ...args: unknown[]) => void;
    warn?: (message: string, ...args: unknown[]) => void;
  };
}

export class InstallReporter {
  constructor(options?: InstallReporterOptions);
  checkAndReport(): Promise<void>;
  reportUninstall(): Promise<void>;
}
