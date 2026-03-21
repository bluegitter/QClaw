export class InstallReporter {
  constructor(options = {}) {
    this.options = options;
  }

  async checkAndReport() {
    if (this.options?.logger?.info) {
      this.options.logger.info("[InstallReporterStub] checkAndReport skipped");
    }
  }

  async reportUninstall() {
    if (this.options?.logger?.info) {
      this.options.logger.info("[InstallReporterStub] reportUninstall skipped");
    }
  }
}
